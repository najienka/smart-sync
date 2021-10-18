import { Block, TransactionResponse, TransactionReceipt } from '@ethersproject/abstract-provider';
import { JsonRpcProvider } from '@ethersproject/providers';
import * as CliProgress from 'cli-progress';
import { logger } from './logger';
import { findDeploymentBlock, toBlockNumber } from './utils';

type KeyObject = {
    '*'?: {
        'to': string
    },
    '+'?: string
};

export type ParityResponseData = {
    stateDiff: {
        [ contractAddress: string ]: {
            storage: {
                [ key: string ] : KeyObject
            }
        };
    }
};

class TransactionHandler {
    private contractAddress: string;

    private provider: JsonRpcProvider;

    private batch: number;

    constructor(contractAddress: string, provider: JsonRpcProvider, batch: number = 50) {
        this.contractAddress = contractAddress;
        this.provider = provider;
        this.batch = batch;
    }

    async getContractStorageFromTxs(latestBlockNumber: string | number = 'latest', earliest_block_number?: string | number): Promise<{ [ key: string ]: string }> {
        const txs = await this.getTransactions(latestBlockNumber, earliest_block_number);
        const contractStorage: { [key: string]: string } = {};

        // getting all tx from srcAddress
        const txStoragePromises: Array<Promise<undefined | { [ key: string ]: string }>> = [];
        let txStorages: Array<{ [ key: string ]: string } | undefined> = [];

        logger.debug(`Replaying ${txs.length} transactions...`);
        const replayBar = new CliProgress.SingleBar({}, CliProgress.Presets.shades_classic);
        replayBar.start(txs.length, 0);
        while (txs.length > 0) {
            const currTx = txs.pop();
            if (currTx) {
                txStoragePromises.push(this.replayTransaction(currTx));
                if (txStoragePromises.length >= this.batch) {
                    // eslint-disable-next-line no-await-in-loop
                    txStorages = txStorages.concat(await Promise.all(txStoragePromises));
                    replayBar.increment(this.batch);
                }
            }
        }
        replayBar.stop();
        logger.debug('Done.');
        txStorages.forEach((storage) => {
            if (storage) {
                logger.debug('srcTx txStorage: ', storage);

                Object.entries(storage).forEach(([key, value]) => {
                    if (!key.match(/0x0{64}/)) contractStorage[key] = value;
                });
            }
        });

        return contractStorage;
    }

    async replayTransaction(transaction: string): Promise<undefined | { [ key: string ]: string }> {
        try {
            const response: ParityResponseData = await this.provider.send('trace_replayTransaction', [transaction, ['stateDiff']]);
            // Ensure the state has been changed

            if (Object.prototype.hasOwnProperty.call(response.stateDiff, this.contractAddress.toLowerCase())) {
                const tx = response.stateDiff[this.contractAddress.toLowerCase()];
                logger.debug('tx: ', transaction);
                if (tx) {
                    const txStorage = tx.storage;
                    const keys = Object.keys(txStorage);
                    const obj: { [ key: string ]: string } = {};
                    keys.forEach((key) => {
                        // First case: normal tx
                        // Second case: deploying tx
                        const keyObject: KeyObject = txStorage[key];
                        if (keyObject['*'] !== undefined) obj[key] = keyObject['*'].to;
                        else if (keyObject['+'] !== undefined) obj[key] = keyObject['+'];
                    });
                    return obj;
                }
            }
        } catch (err) {
            logger.error(err);
        }
        return undefined;
    }

    async getTransactions(latest_block_number: number | string, earliest_block_number?: number | string): Promise<Array<string>> {
        logger.debug('Called getTransactions');
        const contractAddress: string = this.contractAddress.toUpperCase();
        const relatedTransactions: Array<string> = [];
        let latest = latest_block_number;
        if (typeof (latest) === 'string') latest = await toBlockNumber(latest, this.provider);

        // first find deployment block for more efficiency
        let earliest = (earliest_block_number && earliest_block_number !== 'earliest') ? earliest_block_number : await findDeploymentBlock(this.contractAddress, this.provider);
        if (typeof (earliest) === 'string') earliest = await toBlockNumber(earliest, this.provider);

        if (latest < earliest) {
            logger.debug(`Given latest block number ${latest} older than earliest block number ${earliest}.`);
            return [];
        }

        // gather all transactions
        logger.debug(`Getting ${latest - earliest + 1} blocks...`);
        const blockBar = new CliProgress.SingleBar({}, CliProgress.Presets.shades_classic);
        blockBar.start(latest - earliest + 1, 0);
        let blockPromises: Array<Promise<Block>> = [];
        let blocks: Array<Block> = [];
        for (let i = earliest; i <= latest; i += 1) {
            blockPromises.push(this.provider.getBlock(i));
            if (blockPromises.length >= this.batch) {
                blockPromises.forEach((blockPromise) => {
                    blockPromise.catch((error) => {
                        logger.error(error);
                        process.exit(-1);
                    });
                });
                // eslint-disable-next-line no-await-in-loop
                blocks = blocks.concat(await Promise.all(blockPromises));
                blockPromises = [];
                blockBar.increment(this.batch);
            }
        }
        if (blockPromises.length > 0) {
            blocks = blocks.concat(await Promise.all(blockPromises));
            blockBar.increment(blockPromises.length);
        }
        blockBar.stop();
        logger.debug('Done.');
        blocks = blocks.filter((value) => (!!value));

        const transactionBar = new CliProgress.SingleBar({}, CliProgress.Presets.shades_classic);
        let transactionPromises: Array<Promise<TransactionResponse>> = [];
        let transactionHashes: Array<string> = [];
        blocks.forEach(({ transactions }) => {
            transactionHashes = transactionHashes.concat(transactions);
        });
        let transactions: Array<TransactionResponse> = [];
        logger.debug(`Getting ${transactionHashes.length} transactions...`);
        transactionBar.start(transactionHashes.length, 0);
        while (transactionHashes.length > 0) {
            const currTx = transactionHashes.pop();
            if (currTx) {
                const txPromise = this.provider.getTransaction(currTx);
                txPromise.catch((error) => {
                    logger.error(error);
                    process.exit(-1);
                });
                transactionPromises.push(txPromise);
                if (transactionPromises.length >= this.batch) {
                    // eslint-disable-next-line no-await-in-loop
                    transactions = transactions.concat(await Promise.all(transactionPromises));
                    transactionPromises = [];
                    transactionBar.increment(this.batch);
                }
            }
        }
        if (transactionPromises.length > 0) {
            transactions = transactions.concat(await Promise.all(transactionPromises));
            transactionBar.increment(transactionPromises.length);
        }
        transactionBar.stop();
        logger.debug('Done.');

        logger.debug('Getting receipts and related txs...');
        const receiptBar = new CliProgress.SingleBar({}, CliProgress.Presets.shades_classic);
        let receiptPromises: Array<Promise<TransactionReceipt>> = [];
        const receiptHashes: Array<string> = [];
        let receipts: Array<TransactionReceipt> = [];
        receiptBar.start(transactions.length, 0);
        transactions.forEach((tx) => {
            if (tx.to) {
                if (tx.to.toUpperCase() === contractAddress) {
                    relatedTransactions.push(tx.hash);
                    receiptBar.increment();
                }
            } else {
                receiptHashes.push(tx.hash);
            }
        });
        while (receiptHashes.length > 0) {
            const currReceiptHash = receiptHashes.pop();
            if (currReceiptHash) {
                receiptPromises.push(this.provider.getTransactionReceipt(currReceiptHash));
                if (receiptPromises.length >= this.batch) {
                    receiptPromises.forEach((receiptPromise) => {
                        receiptPromise.catch((error) => {
                            logger.error(error);
                            process.exit(-1);
                        });
                    });
                    // eslint-disable-next-line no-await-in-loop
                    receipts = receipts.concat(await Promise.all(receiptPromises));
                    receiptPromises = [];
                    receiptBar.increment(this.batch);
                }
            }
        }
        if (receiptPromises.length > 0) {
            receipts = receipts.concat(await Promise.all(receiptPromises));
            receiptBar.increment(receiptPromises.length);
        }

        receipts.forEach((receipt) => {
            if (receipt.contractAddress && receipt.contractAddress.toUpperCase() === contractAddress) {
                relatedTransactions.push(receipt.transactionHash);
                receiptBar.increment();
            }
        });
        receiptBar.stop();
        logger.debug('Done.');

        return relatedTransactions;
    }
}

export default TransactionHandler;
