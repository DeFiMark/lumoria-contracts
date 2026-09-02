//SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "./IERC20.sol";

interface ILumoriaToken is IERC20 {

    /// @notice Display metadata written into the token at launch.
    ///
    ///         `description` is deliberately ABSENT: it lives in the
    ///         `contractURI` JSON only. A description is the one field that is
    ///         both long (hundreds of bytes = tens of storage slots) and never
    ///         read by an on-chain consumer, so paying to store it on every
    ///         launch buys nothing the JSON does not already give.
    ///
    ///         Every field is a URI or a JSON string, never raw bytes — the
    ///         chain stores the pointer, permanent storage holds the payload.
    struct Metadata {
        /// @notice Artwork URI. Canonically an `https://` gateway URL to
        ///         immutable content-addressed storage (Arweave), because
        ///         indexers handle `ar://` / `ipfs://` inconsistently.
        string image;
        /// @notice Social links as ONE JSON string, e.g.
        ///         `{"website":"…","twitter":"…","telegram":"…"}`. A single
        ///         string keeps the struct (and therefore the launch calldata)
        ///         a fixed shape as the set of platforms grows.
        string socials;
        /// @notice ERC-7572 contract-level metadata: a URI to a JSON document
        ///         carrying name/symbol/description/image/socials.
        string contractURI;
    }

    /// @dev ERC-7572. Carries no arguments by spec — indexers re-read
    ///      `contractURI()` when they see it.
    event ContractURIUpdated();
    event ImageUpdated(string image);
    event SocialsUpdated(string socials);

    function __init__(
        string calldata name_,
        string calldata symbol_,
        address pair_,
        address taxHandler_,
        address creator_,
        Metadata calldata metadata_
    ) external;

    function burn(uint256 amount) external;

    function pair() external view returns (address);
    function taxHandler() external view returns (address);
    function creator() external view returns (address);

    // ─── Metadata ──────────────────────────────────────────────────

    function contractURI() external view returns (string memory);
    function image() external view returns (string memory);
    function logo() external view returns (string memory);
    function socials() external view returns (string memory);

    function setContractURI(string calldata uri) external;
    function setImage(string calldata image_) external;
    function setSocials(string calldata socials_) external;
}
