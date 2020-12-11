//SPDX-License-Identifier: Unlicense
pragma solidity >=0.5.0 <0.8.0;

import "./contracts/RelayContract.sol";
import "./contracts/GetProofLib.sol";
import "solidity-rlp/contracts/RLPReader.sol";

contract ProxyContract {
    using RLPReader for RLPReader.RLPItem;
    using RLPReader for RLPReader.Iterator;
    using RLPReader for bytes;

    /**
    * @dev address of the deployed relay contract.
    * The address in the file is a placeholder
    */
    address internal constant RELAY_ADDRESS = 0xeBf794b5Cf0217CB806f48d2217D3ceE1e25A7C3;
    /**
    * @dev address of the contract that is being mirrored.
    * The address in the file is a placeholder
    */
    address internal constant LOGIC_ADDRESS = 0x0a911618A3dD806a5D14bf856cf355C4b9C84526;

    /**
    * @dev initialize the storage of this contract based on the provided proof.
    * @param proof The rlp encoded EIP1186 proof
    * @param blockHash The blockhash of the source chain the proof represents the state of
    */
    constructor(bytes memory proof, uint256 blockHash) public {
        updateStorage(proof, blockHash);
    }
    // 1. Account Proof: proof vom source block -> account
    // 2. old contract state proof: current value -> current storage root (address -> storage)
    // 3. New contract state proof: ein oder mehrere (key -> value) -> source storage root

    /**
    * @dev Several steps happen before a storage update takes place:
    * First verify that the provided proof was obtained for the account on the source chain (account proof)
    * Secondly verify that the current value is part of the current storage root (old contract state proof)
    * Third step is verifying the provided storage proofs provided in the `proof` (new contract state proof)
    * @param proof The rlp encoded EIP1186 proof
    * @param the hash of the block that contains the state of source contract we're trying to update to
    */
    function updateStorage(bytes memory proof, uint256 blockHash) public {
        RelayContract relay = getRelay();
        bytes32 root = relay.getStateRoot(blockHash);
        bytes memory path = GetProofLib.encodedAddress(relay.getSource());
        GetProofLib.GetProof memory getProof = GetProofLib.parseProof(proof);

        require(GetProofLib.verifyProof(getProof.account, getProof.accountProof, path, root), "Failed to verify the account proof");

        GetProofLib.Account memory account = GetProofLib.parseAccount(getProof.account);

//        bytes32 storageRoot = relay.getStorageRoot(blockHash);
//        require(account.storageHash == storageRoot, "Storage root mismatch");

        setStorage(getProof.storageProofs, account.storageHash);

        // update the state in the relay
        relay.setCurrentStateBlock(blockHash);
    }


    /**
    * @dev Used to access the Relay's abi
    */
    function getRelay() internal view returns (RelayContract) {
        return RelayContract(RELAY_ADDRESS);
    }

    /**
    * @dev Sets the contract's storage based on the encoded storage
    * @param rlpStorage the rlp encoded list of storageproofs
    * @param storageHash the hash of the contract's storage
    */
    function setStorage(bytes memory rlpStorage, bytes32 storageHash) internal {
        RLPReader.Iterator memory it =
        rlpStorage.toRlpItem().iterator();

        while (it.hasNext()) {
            // parse the rlp encoded storage proof
            GetProofLib.StorageProof memory proof = GetProofLib.parseStorageProof(it.next().toBytes());

            // get the path in the trie leading to the value
            bytes memory path = GetProofLib.triePath(abi.encodePacked(proof.key));

            // verify the storage proof
            require(MerklePatriciaProof.verify(
                    proof.value, path, proof.proof, storageHash
                ), "Failed to verify the storage proof");

            // decode the rlp encoded value
            bytes32 value = bytes32(proof.value.toRlpItem().toUint());

            // store the value in the right slot
            bytes32 slot = proof.key;
            assembly {
                sstore(slot, value)
            }
        }
    }
}
