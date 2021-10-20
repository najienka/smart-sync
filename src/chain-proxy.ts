import { Contract, ContractReceipt, ContractTransaction } from '@ethersproject/contracts';
import { JsonRpcProvider } from '@ethersproject/providers';
import { ConnectionInfo } from '@ethersproject/web';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import { BigNumber, BigNumberish, ethers } from 'ethers';
import { TransactionReceipt, TransactionResponse } from '@ethersproject/abstract-provider';
import * as rlp from 'rlp';
import { RelayContract, RelayContract__factory } from '../src-gen/types';
import { PROXY_INTERFACE } from './config';
import DiffHandler from './diffHandler/DiffHandler';
import { logger } from './utils/logger';
import {
    getAllKeys, toParityQuantity, toBlockNumber, createDeployingByteCode,
} from './utils/utils';
import GetProof from './proofHandler/GetProof';
import { BlockHeader } from './proofHandler/Types';
import ProxyContractBuilder from './utils/proxy-contract-builder';
import StorageDiff from './diffHandler/StorageDiff';
import FileHandler from './utils/fileHandler';
import ProviderHandler from './utils/providerHandler';

const KEY_VALUE_PAIR_PER_BATCH = 100;

export type ContractAddressMap = {
    srcContract?: string;
    relayContract?: string;
    logicContract?: string;
    proxyContract?: string;
};

export type DeployingTransation = TransactionResponse & {
    creates?: string;
};

export type RPCConfig = {
    gasLimit?: BigNumberish;
    blockNr?: string | number;
    targetAccountEncryptedJsonPath?: string;
    targetAccountPassword?: string;
    providerApiKey?: string;
};

export type GetDiffMethod = 'srcTx' | 'storage' | 'getProof';

export function encodeBlockHeader(blockHeader: BlockHeader): Buffer {
    // needed parameters for block header hash
    // https://ethereum.stackexchange.com/questions/67055/block-header-hash-verification
    const cleanBlockHeader = [
        blockHeader.parentHash,
        blockHeader.sha3Uncles,
        blockHeader.miner,
        blockHeader.stateRoot,
        blockHeader.transactionsRoot,
        blockHeader.receiptsRoot,
        blockHeader.logsBloom,
        ethers.BigNumber.from(blockHeader.difficulty).toHexString(),
        ethers.BigNumber.from(blockHeader.number).toHexString(),
        ethers.BigNumber.from(blockHeader.gasLimit).toHexString(),
        ethers.BigNumber.from(blockHeader.gasUsed).toHexString(),
        ethers.BigNumber.from(blockHeader.timestamp).toHexString(),
        blockHeader.extraData,
    ];
    if (blockHeader.mixHash && blockHeader.nonce) {
    // if chain is PoW
        cleanBlockHeader.push(blockHeader.mixHash);
        cleanBlockHeader.push(blockHeader.nonce);
    } // else chain is PoA
    return Buffer.from(rlp.encode(cleanBlockHeader));
}

export class ChainProxy {
    readonly values: Array<number> = [];

    readonly keys: Array<number> = [];

    private proxyContract: Contract;

    readonly proxyContractAddress: string | undefined;

    srcContractAddress: string;

    private logicContractAddress: string | undefined;

    private relayContractAddress: string | undefined;

    readonly srcProvider: JsonRpcProvider;

    readonly srcProviderConnectionInfo: ConnectionInfo;

    readonly targetProviderConnectionInfo: ConnectionInfo;

    readonly targetProvider: JsonRpcProvider;

    readonly targetRPCConfig: RPCConfig;

    private relayContract: RelayContract;

    private deployer: SignerWithAddress | ethers.Wallet;

    private differ: DiffHandler;

    public migrationState: Boolean;

    private initialized: Boolean;

    private batchSize: number;

    private srcBlock: string | number;

    private targetBlock: string | number;

    constructor(contractAddresses: ContractAddressMap, srcProviderConnectionInfo: ConnectionInfo, srcRPCConfig: RPCConfig, targetProviderConnectionInfo: ConnectionInfo, targetRPCConfig: RPCConfig, batch: number = 50) {
        if (contractAddresses.srcContract) {
            this.srcContractAddress = contractAddresses.srcContract;
        }
        this.batchSize = batch;
        this.logicContractAddress = contractAddresses.logicContract;
        this.relayContractAddress = contractAddresses.relayContract;
        this.proxyContractAddress = contractAddresses.proxyContract;
        this.srcProviderConnectionInfo = srcProviderConnectionInfo;
        const srcProviderHandler = new ProviderHandler(this.srcProviderConnectionInfo, srcRPCConfig.providerApiKey);
        this.srcProvider = srcProviderHandler.getProviderInstance();
        this.targetProviderConnectionInfo = targetProviderConnectionInfo;
        const targetProviderHandler = new ProviderHandler(this.targetProviderConnectionInfo, targetRPCConfig.providerApiKey);
        this.targetProvider = targetProviderHandler.getProviderInstance();
        this.targetRPCConfig = targetRPCConfig;
        this.initialized = false;
        this.migrationState = false;
        this.srcBlock = srcRPCConfig.blockNr ?? 'latest';
        this.targetBlock = targetRPCConfig.blockNr ?? 'latest';
        if (targetRPCConfig.targetAccountEncryptedJsonPath && targetRPCConfig.targetAccountPassword) {
            const fh = new FileHandler(targetRPCConfig.targetAccountEncryptedJsonPath);
            const encryptedJson = fh.read();
            if (!encryptedJson) {
                logger.error(`Could not access json file at ${targetRPCConfig.targetAccountEncryptedJsonPath}`);
                process.exit(-1);
            }
            logger.debug('Decrypting account json file...');
            this.deployer = ethers.Wallet.fromEncryptedJsonSync(encryptedJson, targetRPCConfig.targetAccountPassword);
            logger.debug('Done.');
            this.deployer = new ethers.Wallet(this.deployer.privateKey, this.targetProvider);
        } else if (targetRPCConfig.targetAccountEncryptedJsonPath) {
            logger.error(`No password given to decrypt json file at ${targetRPCConfig.targetAccountEncryptedJsonPath}`);
            process.exit(-1);
        }
    }

    async init(): Promise<Boolean> {
        try {
            if (!this.deployer) {
                logger.info('No target account provided. Will try to get unlocked account from target chain client.');
                this.deployer = await SignerWithAddress.create(this.targetProvider.getSigner());
            }
        } catch (e) {
            logger.error(e);
            return false;
        }

        if (this.relayContractAddress) {
            const relayContractFactory = new RelayContract__factory(this.deployer);
            this.relayContract = relayContractFactory.attach(this.relayContractAddress);
        }

        if (this.proxyContractAddress) {
            try {
                // attach to proxy
                const compiledProxy = await ProxyContractBuilder.compiledAbiAndBytecode(this.relayContract?.address ?? this.proxyContractAddress, this.logicContractAddress ?? this.proxyContractAddress, this.srcContractAddress ?? this.proxyContractAddress);
                if (compiledProxy.error) return false;
                const proxyFactory = new ethers.ContractFactory(PROXY_INTERFACE, compiledProxy.bytecode, this.deployer);
                this.proxyContract = proxyFactory.attach(this.proxyContractAddress);

                // get contract addresses from proxy
                this.srcContractAddress = await this.proxyContract.getSourceAddress();
                logger.debug(`srcContract: ${this.srcContractAddress}`);
                this.logicContractAddress = await this.proxyContract.getLogicAddress();

                this.relayContractAddress = await this.proxyContract.getRelayAddress();
                if (!this.relayContractAddress) {
                    logger.error('Could not get relay contract address.');
                    return false;
                }
                const relayContractFactory = new RelayContract__factory(this.deployer);
                this.relayContract = relayContractFactory.attach(this.relayContractAddress);

                this.migrationState = await this.relayContract.getMigrationState(this.proxyContractAddress);
            } catch (e) {
                logger.error(e);
                return false;
            }
        }

        // todo batch size in DiffHandler
        this.differ = new DiffHandler(this.srcProvider, this.targetProvider);
        this.initialized = true;
        return true;
    }

    /**
     *
     * @param srcBlock block from where to migrate src contract from
     * @returns bool indicating if migration was sucessfull or not
     */
    async migrateSrcContract(srcBlock: BigNumberish = 'latest'): Promise<Boolean> {
        if (!this.initialized) {
            logger.error('ChainProxy is not initialized yet.');
            return false;
        }
        if (!ethers.utils.isAddress(this.srcContractAddress)) {
            logger.error(`Given source contract address not a valid address (${this.srcContractAddress})`);
            return false;
        }
        try {
            if ((await this.srcProvider.getCode(this.srcContractAddress)).length < 3) {
                logger.error(`No contract found under src contract address ${this.srcContractAddress}.`);
                return false;
            }
        } catch (e) {
            logger.error(e);
            return false;
        }

        if (!this.relayContract) {
            logger.info('No address for relayContract given, deploying new relay contract...');
            const relayFactory = new RelayContract__factory(this.deployer);
            this.relayContract = await relayFactory.deploy();
            logger.info(`Relay contract address: ${this.relayContract.address}`);
        }
        const srcBlockParity = toParityQuantity(srcBlock);
        const keys = await getAllKeys(this.srcContractAddress, this.srcProvider, srcBlockParity, this.batchSize);
        const latestBlock = await this.srcProvider.send('eth_getBlockByNumber', [srcBlockParity, true]);
        // create a proof of the source contract's storage
        const initialValuesProof = new GetProof(await this.srcProvider.send('eth_getProof', [this.srcContractAddress, keys, srcBlockParity]));

        // update relay
        await this.relayContract.addBlock(latestBlock.stateRoot, latestBlock.number);

        // deploy logic contract
        let result = await this.cloneLogic();
        if (!result) return false;

        // deploy empty proxy
        result = await this.deployProxy();
        if (!result) return false;

        // migrate storage
        result = await this.initialStorageMigration(initialValuesProof, latestBlock.stateRoot, latestBlock.number);
        if (!result) return false;

        logger.info(`Address of proxyContract: ${this.proxyContract.address}`);

        // todo write out all the addresses into a file?
        return true;
    }

    /**
     * deploy logic of source contract to target chain
     * @returns address of logic contract or undefined if error
     */
    private async cloneLogic(): Promise<Boolean> {
        logger.debug('cloning logic to target chain...');
        const logicContractByteCode: string = await createDeployingByteCode(this.srcContractAddress, this.srcProvider);
        const logicFactory = new ethers.ContractFactory([], logicContractByteCode, this.deployer);
        try {
            const logicContract = await logicFactory.deploy();
            const gasUsedForDeployment = (await logicContract.deployTransaction.wait()).gasUsed.toNumber();
            logger.debug(`Gas used for deploying logicContract: ${gasUsedForDeployment}`);
            this.logicContractAddress = logicContract.address;
        } catch (e) {
            logger.error(e);
            return false;
        }
        logger.debug('done.');
        logger.info(`Logic contract address: ${this.logicContractAddress}`);
        return true;
    }

    /**
     * deploy proxy contract to target chain
     * @returns address of proxy contract or undefined if error
     */
    private async deployProxy(): Promise<boolean> {
        if (this.logicContractAddress === undefined) {
            logger.error('Cannot deploy proxy when logic contract is still undefined.');
            return false;
        }
        const compiledProxy = await ProxyContractBuilder.compiledAbiAndBytecode(this.relayContract.address, this.logicContractAddress, this.srcContractAddress);
        if (compiledProxy.error) return false;
        const proxyFactory = new ethers.ContractFactory(PROXY_INTERFACE, compiledProxy.bytecode, this.deployer);
        try {
            this.proxyContract = await proxyFactory.deploy();
            const gasUsedForDeployment = (await this.proxyContract.deployTransaction.wait()).gasUsed.toNumber();
            logger.debug(`Gas used for deploying proxyContract: ${gasUsedForDeployment}`);
        } catch (e) {
            logger.error(e);
            return false;
        }
        return true;
    }

    private async initialStorageMigration(initialValuesProof: GetProof, stateRoot: string, blockNumber: string): Promise<boolean> {
        // migrate storage
        logger.debug('migrating storage');
        const proxyKeys: Array<String> = [];
        const proxyValues: Array<String> = [];
        initialValuesProof.storageProof.forEach((storageProof) => {
            proxyKeys.push(ethers.utils.hexZeroPad(storageProof.key, 32));
            proxyValues.push(ethers.utils.hexZeroPad(storageProof.value, 32));
        });

        // todo adjust batch according to gas estimations
        // todo add option for adjust key value pair batch
        let storageAdds: Array<Promise<TransactionResponse>> = [];
        let txs: Array<TransactionResponse> = [];
        while (proxyKeys.length > 0) {
            storageAdds.push(this.proxyContract.addStorage(proxyKeys.splice(0, KEY_VALUE_PAIR_PER_BATCH), proxyValues.splice(0, KEY_VALUE_PAIR_PER_BATCH)));
            if (storageAdds.length >= this.batchSize) {
                // eslint-disable-next-line no-await-in-loop
                const resolvedTxs = await Promise.all(storageAdds);
                resolvedTxs.forEach((tx) => {
                    if (!tx) {
                        logger.error('Could not add at least one storage batch.');
                        process.exit(-1);
                    }
                });
                txs = txs.concat(resolvedTxs);
                storageAdds = [];
            }
        }
        const resolvedTxs = await Promise.all(storageAdds);
        resolvedTxs.forEach((tx) => {
            if (!tx) {
                logger.error('Could not add at least one storage batch.');
                process.exit(-1);
            }
        });
        txs = txs.concat(resolvedTxs);

        const txsReceiptPromises: Array<Promise<TransactionReceipt>> = [];
        let cumulativeGasUsed = 0;
        txs.forEach((tx) => {
            txsReceiptPromises.push(tx.wait());
        });
        const txsReceipts: Array<TransactionReceipt> = await Promise.all(txsReceiptPromises);
        txsReceipts.forEach((receipt) => {
            cumulativeGasUsed += receipt.gasUsed.toNumber();
        });
        logger.debug(`Gas used for migrating state in ${txs.length} txs: ${cumulativeGasUsed}`);
        logger.debug('done.');

        // validate migration
        //  getting account proof from source contract
        const sourceAccountProof = await initialValuesProof.optimizedProof(stateRoot, false);

        //  getting account proof from proxy contract
        const latestProxyChainBlock = await this.targetProvider.send('eth_getBlockByNumber', ['latest', false]);
        const proxyChainProof = new GetProof(await this.targetProvider.send('eth_getProof', [this.proxyContract.address, []]));
        const proxyAccountProof = await proxyChainProof.optimizedProof(latestProxyChainBlock.stateRoot, false);

        //  getting encoded block header
        const encodedBlockHeader = encodeBlockHeader(latestProxyChainBlock);

        try {
            const tx = await this.relayContract.verifyMigrateContract(sourceAccountProof, proxyAccountProof, encodedBlockHeader, this.proxyContract.address, ethers.BigNumber.from(latestProxyChainBlock.number).toNumber(), blockNumber, { gasLimit: this.targetRPCConfig.gasLimit });
            const gasUsedForTx = (await tx.wait()).gasUsed.toNumber();
            logger.debug(`Gas used for verifying contract migration: ${gasUsedForTx}`);
        } catch (e) {
            logger.error(e);
            return false;
        }

        //  validating
        try {
            const migrationValidated = await this.relayContract.getMigrationState(this.proxyContract.address);
            this.migrationState = migrationValidated;
            if (!this.migrationState) {
                logger.error('Could not migrate srcContract.');
                return false;
            }
            return true;
        } catch (e) {
            logger.error(e);
            return false;
        }
    }

    async migrateChangesToProxy(changedKeys: Array<BigNumberish>, targetBlock: string | number = this.targetBlock): Promise<Boolean> {
        if (!this.initialized) {
            logger.error('ChainProxy is not initialized yet.');
            return false;
        } if (!this.migrationState) {
            logger.error('Proxy contract is not initialized yet.');
            return false;
        } if (changedKeys.length < 1) {
            logger.info('There are no changes to be synchronized.');
            return true;
        } if (!this.relayContract) {
            logger.error('No address for relayContract given.');
            return false;
        }

        const parityLatestSrcBlock = toParityQuantity(targetBlock);
        const latestBlock = await this.srcProvider.send('eth_getBlockByNumber', [parityLatestSrcBlock, true]);

        // create a proof of the source contract's storage for all the changed keys
        const changedKeysProof = new GetProof(await this.srcProvider.send('eth_getProof', [this.srcContractAddress, changedKeys, parityLatestSrcBlock]));

        const rlpProof = await changedKeysProof.optimizedProof(latestBlock.stateRoot);

        await this.relayContract.addBlock(latestBlock.stateRoot, latestBlock.number);

        // update the proxy storage
        let txResponse: ContractTransaction;
        let receipt: ContractReceipt;
        try {
            txResponse = await this.proxyContract.updateStorage(rlpProof, latestBlock.number, { gasLimit: this.targetRPCConfig.gasLimit });
            receipt = await txResponse.wait();
            logger.debug(`Gas used for updating storage ${receipt.gasUsed.toNumber()}`);
        } catch (e) {
            logger.fatal('Could not updateStorage.');
            logger.fatal(e);
            return false;
        }

        return true;
    }

    async getDiff(method: GetDiffMethod, parameters: any): Promise<StorageDiff | undefined> {
        if (!this.initialized) {
            logger.error('ChainProxy is not initialized yet.');
            return undefined;
        }

        let { srcBlock } = parameters;
        const { targetBlock } = parameters;
        switch (method) {
            case 'storage':
                if (!this.proxyContractAddress) {
                    logger.error('Proxy address not given.');
                    return undefined;
                } if (!this.migrationState) {
                    logger.error('Proxy contract is not initialized yet.');
                    return undefined;
                }
                return this.differ.getDiffFromStorage(this.srcContractAddress, this.proxyContractAddress, parameters.srcBlock, parameters.targetBlock);
            case 'getProof':
                if (this.relayContract && this.proxyContract) {
                    const synchedBlockNr = await this.relayContract.getCurrentBlockNumber(this.proxyContract.address);
                    srcBlock = synchedBlockNr.toNumber() + 1;
                }
                if (targetBlock) {
                    const givenTargetBlockNr = await toBlockNumber(targetBlock, this.srcProvider);
                    if (BigNumber.from(srcBlock).gt(givenTargetBlockNr)) {
                        logger.debug(`Note: The given starting block nr/ synchronized block nr (--src-BlockNr == ${srcBlock}) is greater than the given target block nr (${targetBlock}).`);
                        return new StorageDiff([]);
                    }
                }
                return this.differ.getDiffFromProof(this.srcContractAddress, parameters.targetBlock, srcBlock);
                // srcTx is default
            default:
                if (this.relayContract && this.proxyContract) {
                    const synchedBlockNr = await this.relayContract.getCurrentBlockNumber(this.proxyContract.address);
                    srcBlock = synchedBlockNr.toNumber() + 1;
                }
                if (targetBlock) {
                    const givenTargetBlockNr = await toBlockNumber(targetBlock, this.srcProvider);
                    if (BigNumber.from(srcBlock).gt(givenTargetBlockNr)) {
                        logger.debug(`Note: The given starting block nr/ synchronized block nr (--src-BlockNr == ${srcBlock}) is greater than the given target block nr (${givenTargetBlockNr}).`);
                        return new StorageDiff([]);
                    }
                }
                return this.differ.getDiffFromSrcContractTxs(this.srcContractAddress, parameters.targetBlock, srcBlock);
        }
    }

    async getLatestBlockNumber(): Promise<BigNumber> {
        if (!this.initialized) {
            logger.error('ChainProxy is not initialized yet.');
            return BigNumber.from(-1);
        } if (!this.relayContract) {
            logger.error('No address for relayContract given.');
            return BigNumber.from(-1);
        }

        return this.relayContract.getLatestBlockNumber();
    }

    async getCurrentBlockNumber(): Promise<BigNumber> {
        if (!this.initialized) {
            logger.error('ChainProxy is not initialized yet.');
            return BigNumber.from(-1);
        } if (!this.relayContract) {
            logger.error('No address for relayContract given.');
            return BigNumber.from(-1);
        }

        const currNr = await this.relayContract.getCurrentBlockNumber(this.proxyContract.address);
        this.srcBlock = currNr.toNumber();
        return currNr;
    }

    async getBlockNumber(number: BigNumberish, provider: 'target' | 'src' = 'src'): Promise<number> {
        switch (provider) {
            case 'target':
                return toBlockNumber(number, this.targetProvider);
            default:
                return toBlockNumber(number, this.srcProvider);
        }
    }
}
