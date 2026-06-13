// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20Minimal} from "./RangeTakeProfitBook.sol";

/// @notice Minimal ERC-4626-style yield vault for the testnet demo of the
/// "yield while quoted" experiment (NOTES-yield.md Level 0): books trade the
/// SHARE token; share price appreciates as yield drips in, so unfilled
/// resting principal earns automatically with zero book changes.
contract MockYieldVault {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;

    IERC20Minimal public immutable asset;
    uint256 public totalAssets;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(address _asset, string memory _name, string memory _symbol) {
        asset = IERC20Minimal(_asset);
        name = _name;
        symbol = _symbol;
    }

    function convertToAssets(uint256 shares) public view returns (uint256) {
        return totalSupply == 0 ? shares : (shares * totalAssets) / totalSupply;
    }

    function convertToShares(uint256 assets) public view returns (uint256) {
        return totalSupply == 0 ? assets : (assets * totalSupply) / totalAssets;
    }

    function deposit(uint256 assets, address receiver) external returns (uint256 shares) {
        shares = convertToShares(assets);
        require(asset.transferFrom(msg.sender, address(this), assets), "pull failed");
        totalAssets += assets;
        totalSupply += shares;
        balanceOf[receiver] += shares;
    }

    function redeem(uint256 shares, address receiver, address owner_) external returns (uint256 assets) {
        require(msg.sender == owner_, "owner only (demo)");
        assets = convertToAssets(shares);
        balanceOf[owner_] -= shares;
        totalSupply -= shares;
        totalAssets -= assets;
        require(asset.transfer(receiver, assets), "payout failed");
    }

    /// @notice Simulate yield: anyone deposits assets without minting shares,
    /// appreciating every share (testnet stand-in for Aave/Morpho interest).
    function drip(uint256 assets) external {
        require(asset.transferFrom(msg.sender, address(this), assets), "pull failed");
        totalAssets += assets;
    }

    // ERC20 so books can trade the share token directly
    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}
