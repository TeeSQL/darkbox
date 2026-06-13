// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "../lib/ERC20.sol";

/// @title OutcomeToken
/// @notice ERC-20 YES or NO claim for a single binary market. Mint/burn is
///         restricted to the owning `DarkBoxBinaryMarket` (Pattern A in the
///         market spec §7). Trades freely against synthetic USDC on Frontier.
/// @dev Decimals mirror the collateral (6) so split/join/redeem are exactly 1:1.
contract OutcomeToken is ERC20 {
    /// @notice The market vault that may mint/burn these claims.
    address public immutable market;
    /// @notice The market id this token belongs to (for indexers).
    bytes32 public immutable marketId;

    error NotMarket();

    modifier onlyMarket() {
        if (msg.sender != market) revert NotMarket();
        _;
    }

    constructor(string memory _name, string memory _symbol, uint8 _decimals, bytes32 _marketId)
        ERC20(_name, _symbol, _decimals)
    {
        market = msg.sender;
        marketId = _marketId;
    }

    function mint(address to, uint256 amount) external onlyMarket {
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external onlyMarket {
        _burn(from, amount);
    }
}
