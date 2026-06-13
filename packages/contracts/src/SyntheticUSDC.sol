// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "./lib/ERC20.sol";

/// @title SyntheticUSDC
/// @notice Hidden-chain synthetic USDC credit (TECH_SPEC §10/§12). Minted 1:1
///         against confirmed public escrow deposits by the bridge/coordinator
///         `minter` key. Burned on confirmed withdrawal intent.
/// @dev 6 decimals to mirror real USDC. This is gameplay credit only and has no
///      value outside the hidden chain.
contract SyntheticUSDC is ERC20 {
    /// @notice Authorized minter/burner (bridge/coordinator key).
    address public minter;
    /// @notice Admin able to rotate the minter.
    address public admin;

    event MinterUpdated(address indexed previousMinter, address indexed newMinter);
    event AdminUpdated(address indexed previousAdmin, address indexed newAdmin);

    error NotMinter();
    error NotAdmin();

    modifier onlyMinter() {
        if (msg.sender != minter) revert NotMinter();
        _;
    }

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    constructor(address _admin, address _minter) ERC20("DarkBox Synthetic USDC", "sUSDC", 6) {
        require(_admin != address(0) && _minter != address(0), "zero role");
        admin = _admin;
        minter = _minter;
    }

    /// @notice Mint synthetic credit. Restricted to the bridge/coordinator key.
    function mint(address to, uint256 amount) external onlyMinter {
        _mint(to, amount);
    }

    /// @notice Burn synthetic credit (e.g. on withdrawal). Restricted to minter.
    function burn(address from, uint256 amount) external onlyMinter {
        _burn(from, amount);
    }

    function setMinter(address newMinter) external onlyAdmin {
        require(newMinter != address(0), "minter=0");
        emit MinterUpdated(minter, newMinter);
        minter = newMinter;
    }

    function setAdmin(address newAdmin) external onlyAdmin {
        require(newAdmin != address(0), "admin=0");
        emit AdminUpdated(admin, newAdmin);
        admin = newAdmin;
    }
}
