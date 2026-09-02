//SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "./ITaxHandler.sol";
import "./ILumoriaToken.sol";

interface IGenerator {

    enum LaunchMode { BYOL, FLAT_CURVE, SINGLE_SIDED }

    /// @notice A creator-defined token allocation carved out of the creator's
    ///         post-launch remainder. `duration == 0` sends `amount` straight
    ///         to `beneficiary`; `duration > 0` locks it in the VestingVault
    ///         on a linear+cliff schedule (non-revocable).
    struct AllocationData {
        address beneficiary;
        uint256 amount;
        uint64  cliff;     // seconds after launch before vesting unlocks (≤ duration)
        uint64  duration;  // 0 = immediate transfer; > 0 = linear vest over this many seconds
    }

    event ProjectGenerated(
        address indexed token,
        address indexed taxHandler,
        address indexed creator,
        string name,
        string symbol,
        uint256 buyFee,
        uint256 sellFee,
        uint8 launchMode
    );
    /// @notice The launch's display metadata, as a log.
    ///
    ///         Emitted by the GENERATOR, not the token, and that placement is
    ///         load-bearing for the subgraph: the `LumoriaToken` template is
    ///         spawned by `Database.TokenRegistered` during this same
    ///         transaction, and a dynamic data source cannot observe events
    ///         emitted before it existed. The Generator is a static data source
    ///         indexed from the first block, so this always lands.
    ///
    ///         A separate event rather than three more fields on
    ///         `ProjectGenerated`: metadata and economics change on completely
    ///         different schedules, and consumers that only want the token
    ///         address should not have to decode three strings to get it.
    event TokenMetadataInitialized(
        address indexed token,
        string image,
        string socials,
        string contractURI
    );
    event FlatCurveLaunched(address indexed token, address indexed flatCurve, uint256 hardCap);
    event SingleSidedLaunched(
        address indexed token,
        int24 startTick,
        uint160 sqrtPriceX96,
        uint256 tokenAmountCommitted,
        uint128 liquidity
    );
    /// @notice The owner-tunable mode-2 starting-tick window changed (also
    ///         emitted once from the constructor with the defaults). A lower
    ///         tick is a HIGHER starting FDV: fdvBnb = 1e9 / 1.0001^tick.
    event SingleSidedStartTickBoundsUpdated(int24 minStartTick, int24 maxStartTick);
    event AllocationMinted(address indexed token, address indexed beneficiary, uint256 amount);
    event AllocationVested(
        address indexed token,
        address indexed beneficiary,
        uint256 indexed scheduleId,
        uint256 amount,
        uint64 cliff,
        uint64 duration
    );

    /// @param metadata Display metadata written into the token (artwork /
    ///        socials / ERC-7572 URI). Appended LAST so that every pre-existing
    ///        argument keeps its position — an integrator who misses this
    ///        parameter gets a clean ABI mismatch, never a silently shifted
    ///        `salt`. Pass three empty strings to launch without artwork; the
    ///        creator can set it later via the token's setters.
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
    ) external payable returns (address token, address taxHandler);

    function getDatabase() external view returns (address);

    // ─── Permanent Single-Sided product bounds ─────────────────────

    /// @notice Inclusive [min, max] window a mode-2 `startTick` must fall in.
    ///         Read this before quoting a starting FDV; the vault's own
    ///         TickMath bounds are wider and are not the product limits.
    function singleSidedStartTickBounds()
        external
        view
        returns (int24 minStartTick, int24 maxStartTick);
    function singleSidedMinStartTick() external view returns (int24);
    function singleSidedMaxStartTick() external view returns (int24);

    /// @notice Database-owner only. Both bounds must be tick-spacing aligned
    ///         and `minStartTick <= maxStartTick`.
    function setSingleSidedStartTickBounds(int24 minStartTick, int24 maxStartTick) external;
}
