//SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
    Lumoria Generator

    Single-transaction project launch. Given a name, symbol, fee config,
    module lineup, and launch mode, the Generator:

        1. Clones a Token (deterministic via the user-supplied `salt`).
        2. Clones a TaxHandler.
        3. Initializes the TaxHandler — which in turn clones + inits each
           configured tokenomics module.
        4. Initializes the Token, including its display metadata (artwork /
           socials / ERC-7572 contractURI — see `ILumoriaToken.Metadata`).
           The token's `pair` reference is the Uniswap V4 PoolManager — the
           address that custodies pool reserves, and therefore the address
           excluded from reward-share tracking (exactly the role the V2
           pair used to play).
        5. Registers the token in the Database.
        6. Charges the flat anti-spam launch fee (`Database.launchFeeBnb`,
           absolute wei, owner-tunable) — on EVERY launch mode, forwarded
           to the FeeReceiver with creator context.
        7. Executes the launch mode:
             - BYOL: creator gets (TOTAL_SUPPLY - tokensForLP) tokens,
               Router.addLiquidityETH seeds the V4 pool via the
               LiquidityVault with ALL of (msg.value - launchFee) — no
               percentage skim; the creator supplies their own liquidity.
               Liquidity is permanently locked (the vault has no removal
               path).
             - FLAT_CURVE: msg.value must equal the launch fee exactly.
               Clones a FlatCurve, transfers it
               (tokensForPresale + tokensForLP), gives the creator the
               rest, initializes FlatCurve with the raise config. Raise
               BNB comes from contributors (1% platform fee per
               contribution, forwarded as trade-fee flow).
             - SINGLE_SIDED: msg.value must equal the launch fee exactly.
               Transfers the full supply to the LiquidityVault, which
               initializes and locks one token-only V4 position. The creator
               receives no initial token allocation.

    The Generator holds no custody between transactions. Every call is
    self-contained.

    Must be set as Database.generator() to function (registerToken gates
    on that reference).
 */

import "./interfaces/IGenerator.sol";
import "./interfaces/ITaxHandler.sol";
import "./interfaces/IDatabase.sol";
import "./interfaces/ILumoriaToken.sol";
import "./interfaces/ILumoriaLiquidityVault.sol";
import "./interfaces/ILumoriaRouter.sol";
import "./interfaces/IFlatCurve.sol";
import "./interfaces/IFeeReceiver.sol";
import "./interfaces/IVestingVault.sol";
import "./interfaces/IERC20.sol";
import "./lib/TransferHelper.sol";
import "./lib/ReentrancyGuard.sol";

contract Generator is IGenerator, ReentrancyGuard {

    uint256 public constant BPS = 10000;
    uint256 public constant TOTAL_SUPPLY = 1_000_000_000 * 10**18;
    uint256 public constant MAX_ALLOCATIONS = 100; // gas bound on the launch allocation loop
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    IDatabase public immutable database;

    // ─── Permanent Single-Sided product bounds ─────────────────────
    //
    // The vault enforces only TickMath-safe bounds. These are the PRODUCT
    // bounds on the starting price: they stop unit inversion (typing a
    // token/BNB ratio where BNB/token was meant), unusably thin depth, and
    // absurd starting valuations. Owner-tunable so they can track BNB's
    // dollar price without redeploying anything.
    //
    // Orientation: the pool price is token/BNB, so a LOWER tick means a
    // HIGHER starting FDV. For the fixed 1B supply:
    //
    //     startingFdvBnb = 1e9 / 1.0001^startTick
    //
    //   MIN start tick 148_200 → ≈ 366 BNB starting FDV  (≈ $250k at ~$690/BNB)
    //   MAX start tick 196_260 → ≈   3 BNB starting FDV  (≈ $2k   at ~$690/BNB)
    int24 public constant SINGLE_SIDED_TICK_SPACING = 60;
    int24 public constant DEFAULT_SINGLE_SIDED_MIN_START_TICK = 148_200;
    int24 public constant DEFAULT_SINGLE_SIDED_MAX_START_TICK = 196_260;

    int24 public override singleSidedMinStartTick;
    int24 public override singleSidedMaxStartTick;

    // ─── Events ────────────────────────────────────────────────────

    event BYOLLaunched(address indexed token, uint256 tokensForLP, uint256 bnbForLP);

    constructor(address _database) {
        require(_database != address(0), "Gen: zero database");
        database = IDatabase(_database);
        singleSidedMinStartTick = DEFAULT_SINGLE_SIDED_MIN_START_TICK;
        singleSidedMaxStartTick = DEFAULT_SINGLE_SIDED_MAX_START_TICK;
        emit SingleSidedStartTickBoundsUpdated(
            DEFAULT_SINGLE_SIDED_MIN_START_TICK, DEFAULT_SINGLE_SIDED_MAX_START_TICK
        );
    }

    // ─── Owner Tuning ──────────────────────────────────────────────

    /// @notice Retune the mode-2 starting-tick window. Only the Database
    ///         owner (the platform multisig) may call. Alignment to the pool's
    ///         tick spacing is required so every bound is itself a launchable
    ///         tick; TickMath safety is still enforced by the vault.
    function setSingleSidedStartTickBounds(int24 minStartTick, int24 maxStartTick)
        external
        override
    {
        require(msg.sender == database.owner(), "Gen: only owner");
        require(
            minStartTick % SINGLE_SIDED_TICK_SPACING == 0
                && maxStartTick % SINGLE_SIDED_TICK_SPACING == 0,
            "Gen: unaligned bounds"
        );
        require(minStartTick <= maxStartTick, "Gen: inverted bounds");

        singleSidedMinStartTick = minStartTick;
        singleSidedMaxStartTick = maxStartTick;
        emit SingleSidedStartTickBoundsUpdated(minStartTick, maxStartTick);
    }

    function singleSidedStartTickBounds()
        external
        view
        override
        returns (int24 minStartTick, int24 maxStartTick)
    {
        return (singleSidedMinStartTick, singleSidedMaxStartTick);
    }

    function getDatabase() external view override returns (address) {
        return address(database);
    }

    // ─── Core Entry Point ──────────────────────────────────────────

    function generateProject(
        string calldata name,
        string calldata symbol,
        uint256 buyFee,
        uint256 sellFee,
        ITaxHandler.ModuleInitData[] calldata modules,
        LaunchMode launchMode,
        bytes calldata launchPayload,
        AllocationData[] calldata allocations,
        bytes32 salt,
        ILumoriaToken.Metadata calldata metadata
    ) external payable override nonReentrant returns (address token, address taxHandler) {
        // 1. Deterministic token clone (so the user can pre-compute the token
        //    address off-chain via CREATE2 before the tx lands — useful for
        //    vanity addresses and pre-subgraph-indexing).
        token = _cloneDeterministic(database.tokenMasterCopy(), salt);
        taxHandler = _clone(database.taxHandlerMasterCopy());

        // 2. The token's `pair` is the V4 PoolManager — the singleton that
        //    custodies all pool reserves. LumoriaToken excludes this address
        //    from reward-share tracking (same role the V2 pair played). The
        //    pool itself (PoolId) is deterministic from the token address.
        address pair = database.poolManager();
        require(pair != address(0), "Gen: poolManager unset");

        // 3. Init TaxHandler (clones + inits each module internally)
        ITaxHandler(taxHandler).__init__(
            token,
            address(database),
            msg.sender,
            buyFee,
            sellFee,
            modules
        );

        // 4. Init Token — Generator is msg.sender → receives the 1B supply
        ILumoriaToken(token).__init__(name, symbol, pair, taxHandler, msg.sender, metadata);

        // 5. Register in the Database (the curated-token registry the hook checks)
        database.registerToken(token, msg.sender, taxHandler);

        // 6. Flat anti-spam launch fee — charged on EVERY launch mode, on top
        //    of whatever BNB the mode itself consumes (BYOL: the LP seed;
        //    FLAT_CURVE: nothing). Absolute wei, owner-tunable on the Database.
        uint256 launchFee = database.launchFeeBnb();
        require(msg.value >= launchFee, "Gen: insufficient launch fee");
        if (launchFee > 0) {
            IFeeReceiver(database.feeReceiver()).receiveLaunchFee{value: launchFee}(token, msg.sender);
        }

        // 7. Launch mode (allocations are carved from the creator's remainder)
        if (launchMode == LaunchMode.BYOL) {
            _launchBYOL(token, launchPayload, allocations, msg.value - launchFee);
        } else if (launchMode == LaunchMode.FLAT_CURVE) {
            require(msg.value == launchFee, "Gen: no BNB on FLAT_CURVE");
            _launchFlatCurve(token, taxHandler, launchPayload, allocations);
        } else if (launchMode == LaunchMode.SINGLE_SIDED) {
            require(msg.value == launchFee, "Gen: no BNB on SINGLE_SIDED");
            _launchSingleSided(token, launchPayload, allocations, modules);
        } else {
            revert("Gen: bad launch mode");
        }

        emit ProjectGenerated(
            token, taxHandler, msg.sender, name, symbol, buyFee, sellFee, uint8(launchMode)
        );
        emit TokenMetadataInitialized(
            token, metadata.image, metadata.socials, metadata.contractURI
        );
    }

    // ─── Permanent Single-Sided Launch ─────────────────────────────

    /// @dev payload = abi.encode(int24 startTick). The vault receives the
    ///      entire final supply and permanently commits it to the canonical
    ///      V4 pool; no initial token allocation is permitted.
    function _launchSingleSided(
        address token,
        bytes calldata payload,
        AllocationData[] calldata allocations,
        ITaxHandler.ModuleInitData[] calldata modules
    ) internal {
        require(payload.length == 32, "Gen: bad single-sided payload");
        require(allocations.length == 0, "Gen: allocations disabled");

        uint256 moduleCount = modules.length;
        for (uint256 i = 0; i < moduleCount; i++) {
            require(modules[i].moduleType != 2, "Gen: liquidity module disabled");
        }

        int24 startTick = abi.decode(payload, (int24));
        require(
            startTick >= singleSidedMinStartTick && startTick <= singleSidedMaxStartTick,
            "Gen: start tick out of bounds"
        );
        address vault = database.liquidityVault();
        require(vault != address(0), "Gen: liquidity vault unset");

        TransferHelper.safeTransfer(token, vault, TOTAL_SUPPLY);
        (uint256 tokenAmount, uint128 liquidity, uint160 sqrtPriceX96) =
            ILumoriaLiquidityVault(vault).initializeSingleSided(token, startTick);

        emit SingleSidedLaunched(token, startTick, sqrtPriceX96, tokenAmount, liquidity);
    }

    // ─── BYOL Launch ───────────────────────────────────────────────

    /// @dev payload = abi.encode(uint256 tokensForLP). `forLP` is msg.value
    ///      net of the flat launch fee — ALL of it seeds the pool (no
    ///      percentage skim; the creator is supplying their own liquidity).
    function _launchBYOL(
        address token,
        bytes calldata payload,
        AllocationData[] calldata allocations,
        uint256 forLP
    ) internal {
        uint256 tokensForLP = abi.decode(payload, (uint256));
        require(tokensForLP > 0 && tokensForLP <= TOTAL_SUPPLY, "Gen: bad tokensForLP");
        require(forLP > 0, "Gen: zero BNB");

        // Carve creator-defined allocations out of the remainder, then hand the
        // creator whatever is left. Token transfers are tax-free (plain
        // transfers, not swaps).
        uint256 remainder = TOTAL_SUPPLY - tokensForLP;
        uint256 allocated = _processAllocations(token, allocations);
        require(allocated <= remainder, "Gen: alloc exceeds remainder");
        uint256 tokensForCreator = remainder - allocated;
        if (tokensForCreator > 0) {
            TransferHelper.safeTransfer(token, msg.sender, tokensForCreator);
        }

        // Seed the V4 pool via the Router → LiquidityVault. The pool is
        // lazily initialized at the implied price on this first add, and
        // the liquidity is permanently locked (the vault cannot remove).
        // The `to` parameter is ignored by the V4 router; DEAD is passed
        // for interface compatibility only.
        address router = database.router();
        require(router != address(0), "Gen: router unset");
        TransferHelper.safeApprove(token, router, tokensForLP);
        ILumoriaRouter(router).addLiquidityETH{value: forLP}(
            token, tokensForLP, 0, 0, DEAD, block.timestamp
        );

        emit BYOLLaunched(token, tokensForLP, forLP);
    }

    // ─── FlatCurve Launch ──────────────────────────────────────────

    /// @dev payload = abi.encode(
    ///        uint256 hardCap,
    ///        uint256 minContribution,
    ///        uint256 maxContribution,
    ///        uint256 tokensForPresale,
    ///        uint256 tokensForLP,
    ///        uint256 liquidityBps,
    ///        uint256 creatorBps,
    ///        uint256 startTime,
    ///        uint256 endTime
    ///      )
    function _launchFlatCurve(
        address token,
        address taxHandler,
        bytes calldata payload,
        AllocationData[] calldata allocations
    ) internal {
        (
            uint256 hardCap_,
            ,
            ,
            uint256 tkPre,
            uint256 tkLP,
            ,
            ,
            ,
        ) = abi.decode(
            payload,
            (uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256)
        );

        uint256 totalForCurve = tkPre + tkLP;
        require(totalForCurve > 0 && totalForCurve <= TOTAL_SUPPLY, "Gen: bad token split");

        // Clone FlatCurve
        address flatCurve = _clone(database.flatCurveMasterCopy());

        // Exclude it from reward-share tracking BEFORE it receives any tokens.
        // The FlatCurve custodies presale tokens for contributors who haven't
        // claimed yet; reflections accrued against that balance could never be
        // claimed by anyone. This is the one excluded address that does not
        // exist when the TaxHandler initializes, so the Generator registers it.
        ITaxHandler(taxHandler).excludeFromShares(flatCurve);

        // Move the presale+LP allocation into the FlatCurve
        TransferHelper.safeTransfer(token, flatCurve, totalForCurve);

        // Carve creator-defined allocations out of the remainder, then hand the
        // creator whatever is left.
        uint256 remainder = TOTAL_SUPPLY - totalForCurve;
        uint256 allocated = _processAllocations(token, allocations);
        require(allocated <= remainder, "Gen: alloc exceeds remainder");
        uint256 tokensForCreator = remainder - allocated;
        if (tokensForCreator > 0) {
            TransferHelper.safeTransfer(token, msg.sender, tokensForCreator);
        }

        // Initialize the FlatCurve (state-only; no external calls beyond here)
        IFlatCurve(flatCurve).__init__(token, address(database), msg.sender, payload);

        emit FlatCurveLaunched(token, flatCurve, hardCap_);
    }

    // ─── Allocations ───────────────────────────────────────────────

    /// @dev Distributes creator-defined allocations from the Generator's token
    ///      balance: `duration == 0` transfers straight to the beneficiary;
    ///      otherwise the amount is moved into the VestingVault under a
    ///      linear+cliff schedule. Returns the total tokens allocated so the
    ///      caller can validate it against (and subtract it from) the creator's
    ///      remainder. The sum/over-allocation check lives in the caller.
    function _processAllocations(address token, AllocationData[] calldata allocations)
        internal
        returns (uint256 totalAllocated)
    {
        uint256 len = allocations.length;
        if (len == 0) return 0;
        require(len <= MAX_ALLOCATIONS, "Gen: too many allocations");

        address vault = database.vestingVault();

        for (uint256 i = 0; i < len; i++) {
            AllocationData calldata a = allocations[i];
            require(a.beneficiary != address(0), "Gen: zero beneficiary");
            require(a.amount > 0, "Gen: zero alloc amount");
            totalAllocated += a.amount;

            if (a.duration == 0) {
                // Immediate, unlocked allocation.
                TransferHelper.safeTransfer(token, a.beneficiary, a.amount);
                emit AllocationMinted(token, a.beneficiary, a.amount);
            } else {
                // Vested allocation — park it in the vault and record a schedule.
                require(vault != address(0), "Gen: vesting vault unset");
                TransferHelper.safeTransfer(token, vault, a.amount);
                uint256 id = IVestingVault(vault).createSchedule(
                    token, a.beneficiary, a.amount, a.cliff, a.duration
                );
                emit AllocationVested(token, a.beneficiary, id, a.amount, a.cliff, a.duration);
            }
        }
    }

    // ─── CREATE2 + CREATE1 Clone Helpers ───────────────────────────

    /// @dev Plain ERC-1167 minimal proxy via CREATE.
    function _clone(address implementation) internal returns (address instance) {
        require(implementation != address(0), "Gen: impl unset");
        /// @solidity memory-safe-assembly
        assembly {
            let ptr := mload(0x40)
            mstore(ptr, 0x3d602d80600a3d3981f3363d3d373d3d3d363d73000000000000000000000000)
            mstore(add(ptr, 0x14), shl(0x60, implementation))
            mstore(add(ptr, 0x28), 0x5af43d82803e903d91602b57fd5bf30000000000000000000000000000000000)
            instance := create(0, ptr, 0x37)
        }
        require(instance != address(0), "Gen: create failed");
    }

    /// @dev ERC-1167 minimal proxy via CREATE2 for deterministic addresses.
    function _cloneDeterministic(address implementation, bytes32 salt) internal returns (address instance) {
        require(implementation != address(0), "Gen: impl unset");
        /// @solidity memory-safe-assembly
        assembly {
            let ptr := mload(0x40)
            mstore(ptr, 0x3d602d80600a3d3981f3363d3d373d3d3d363d73000000000000000000000000)
            mstore(add(ptr, 0x14), shl(0x60, implementation))
            mstore(add(ptr, 0x28), 0x5af43d82803e903d91602b57fd5bf30000000000000000000000000000000000)
            instance := create2(0, ptr, 0x37, salt)
        }
        require(instance != address(0), "Gen: create2 failed");
    }

    /// @notice Pre-compute the token address for a given creator+salt, so
    ///         UIs can display it before the transaction lands.
    function predictTokenAddress(bytes32 salt) external view returns (address) {
        address implementation = database.tokenMasterCopy();
        bytes32 bytecodeHash = keccak256(
            abi.encodePacked(
                hex"3d602d80600a3d3981f3363d3d373d3d3d363d73",
                implementation,
                hex"5af43d82803e903d91602b57fd5bf3"
            )
        );
        return address(
            uint160(
                uint256(
                    keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, bytecodeHash))
                )
            )
        );
    }

    // Accept BNB dust refunded by the Router's addLiquidityETH (exact ratios
    // make this a no-op in practice, but the path exists).
    receive() external payable {}
}
