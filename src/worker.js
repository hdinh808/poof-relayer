const fs = require('fs')
const Web3 = require('web3')
const ContractKit = require('@celo/contractkit')
const { toBN, toWei, fromWei } = require('web3-utils')
const MerkleTree = require('fixed-merkle-tree')
const Redis = require('ioredis')
const { GasPriceOracle } = require('gas-price-oracle')
const { Utils, Controller } = require('tornado-cash-anonymity-mining')

const tornadoABI = require('../abis/tornadoABI.json')
const tornadoProxyABI = require('../abis/tornadoProxyABI.json')
const miningABI = require('../abis/mining.abi.json')
const swapABI = require('../abis/swap.abi.json')
const poofABI = require('../abis/poof.abi.json')
const { queue } = require('./queue')
const { poseidonHash2, getInstance, fromDecimals, sleep } = require('./utils')
const { jobType, status } = require('./constants')
const {
  netId,
  poof,
  httpRpcUrl,
  redisUrl,
  privateKey,
  gasLimits,
  instances,
  oracleRpcUrl,
  poofServiceFee,
  miningServiceFee,
  pools,
} = require('./config')
const ENSResolver = require('./resolver')
const resolver = new ENSResolver()
const { calculateFee, calculateRewardFee, calculateSwapFee } = require('@poofcash/poof-kit')

let kit
let account
let currentTx
let currentJob
let tree
let controller
let swap
let minerContract
let proxyContract
const redis = new Redis(redisUrl)
const redisSubscribe = new Redis(redisUrl)
const gasPriceOracle = new GasPriceOracle({ defaultRpc: oracleRpcUrl })

async function fetchTree() {
  const elements = await redis.get('tree:elements')
  const convert = (_, val) => (typeof val === 'string' ? toBN(val) : val)
  tree = MerkleTree.deserialize(JSON.parse(elements, convert), poseidonHash2)

  if (currentTx && currentJob && ['MINING_REWARD', 'MINING_WITHDRAW'].includes(currentJob.data.type)) {
    const { proof, rewardArgs, args } = currentJob.data
    if (toBN(args.account.inputRoot).eq(toBN(tree.root()))) {
      console.log('Account root is up to date. Skipping Root Update operation...')
      return
    } else {
      console.log('Account root is outdated. Starting Root Update operation...')
    }

    const update = await controller.treeUpdate(args.account.outputCommitment, tree)

    const minerAddress = await resolver.resolve(poof.PoofMiner.address)
    const instance = new kit.web3.eth.Contract(miningABI, minerAddress)
    let data
    if (currentJob.data.type === 'MINING_REWARD') {
      data = instance.methods.reward(proof, args, update.proof, update.args).encodeABI()
    } else if (currentJob.data.type === 'MINING_WITHDRAW') {
      data = instance.methods.withdraw(proof, args, update.proof, update.args).encodeABI()
    } else if (currentJob.data.type === 'BATCH_REWARD') {
      data = instance.methods.batchReward(rewardArgs).encodeABI()
    }
    console.log('replaced pending tx')
  }
}

async function start() {
  try {
    const web3 = new Web3(httpRpcUrl)
    kit = ContractKit.newKitFromWeb3(web3)
    kit.connection.addAccount(privateKey)
    account = (await kit.web3.eth.getAccounts())[0]
    swap = new kit.web3.eth.Contract(swapABI, poof.PoofRewardSwap.address)
    minerContract = new kit.web3.eth.Contract(miningABI, poof.PoofMiner.address)
    proxyContract = new kit.web3.eth.Contract(tornadoProxyABI, poof.PoofProxy.address)
    redisSubscribe.subscribe('treeUpdate', fetchTree)
    await fetchTree()
    const provingKeys = {
      treeUpdateCircuit: require('../keys/TreeUpdate.json'),
      treeUpdateProvingKey: fs.readFileSync('./keys/TreeUpdate_proving_key.bin').buffer,
    }
    controller = new Controller({ provingKeys })
    await controller.init()
    queue.process(processJob)
    console.log('Worker started')
  } catch (e) {
    console.error('error on start worker', e.message)
  }
}

function checkFee({ data }) {
  if (data.type === jobType.POOF_WITHDRAW || data.type === jobType.RELAY) {
    return checkPoofFee(data)
  } else if (data.type === jobType.BATCH_REWARD) {
    return checkBatchMiningFee(data)
  } else if (data.type === jobType.WITHDRAW_V2) {
    return checkWithdrawV2Fee(data)
  }
  return checkMiningFee(data)
}

async function checkPoofFee({ args, contract }) {
  const { currency, amount } = getInstance(contract)
  const { decimals } = instances[`netId${netId}`][currency]
  const [fee, refund] = [args[4], args[5]].map(toBN)
  const gasPrice = await redis.hget('gasPrices', 'min')

  const celoPrice = await redis.hget('prices', currency)
  const feePercent = toBN(fromDecimals(amount, decimals))
    .mul(toBN(poofServiceFee * 1e10))
    .div(toBN(1e10 * 100))

  const desiredFee = calculateFee(
    gasPrice.toString(),
    amount.toString(),
    refund.toString(),
    celoPrice.toString(),
    poofServiceFee.toString(),
    decimals,
    gasLimits[jobType.POOF_WITHDRAW],
  )
  console.log(
    'sent fee, desired fee, feePercent',
    fromWei(fee.toString()),
    fromWei(desiredFee.toString()),
    fromWei(feePercent.toString()),
  )
  if (fee.lt(desiredFee)) {
    throw new Error('Provided fee is not enough. Probably it is a Gas Price spike, try to resubmit.')
  }
}

async function checkBatchMiningFee({ args: argList }) {
  for (const args of argList) {
    checkMiningFee({ args })
  }
}

async function checkMiningFee({ args }) {
  const gasPrice = await redis.hget('gasPrices', 'min')
  const celoPrice = await redis.hget('prices', 'poof')
  const isMiningReward = currentJob.data.type === jobType.MINING_REWARD
  const providedFee = isMiningReward ? toBN(args.fee) : toBN(args.extData.fee)
  const balance = await swap.methods.poofVirtualBalance().call()
  const poolWeight = await swap.methods.poolWeight().call()

  let desiredFee
  if (isMiningReward) {
    desiredFee = calculateRewardFee(gasPrice, celoPrice, balance, poolWeight)
  } else {
    desiredFee = calculateSwapFee(gasPrice, celoPrice, balance, poolWeight, miningServiceFee, args.amount)
  }

  console.log('user provided fee, desired fee', providedFee.toString(), desiredFee.toString())
  if (toBN(providedFee).lt(desiredFee)) {
    throw new Error('Provided fee is not enough. Probably it is a Gas Price spike, try to resubmit.')
  }
}

async function checkWithdrawV2Fee({ args, contract }) {
  const { symbol, decimals } = pools[netId].find(
    entry => entry.poolAddress.toLowerCase() === contract.toLowerCase(),
  )
  const [fee, amount] = [args.extData.fee, args.amount].map(toBN)
  const gasPrice = await redis.hget('gasPrices', 'min')

  const celoPrice = await redis.hget('prices', symbol.toLowerCase())
  const feePercent = toBN(fromDecimals(amount, decimals))
    .mul(toBN(poofServiceFee * 1e10))
    .div(toBN(1e10 * 100))

  const desiredFee = calculateFee(
    gasPrice.toString(),
    fromWei(amount), // HARDCODE: 18 decimal assumption
    '0',
    celoPrice.toString(),
    poofServiceFee.toString(),
    decimals,
    gasLimits[jobType.POOF_WITHDRAW],
  )
  console.log(
    'sent fee, desired fee, feePercent',
    fromWei(fee.toString()),
    fromWei(desiredFee.toString()),
    fromWei(feePercent.toString()),
  )
  if (fee.lt(desiredFee)) {
    throw new Error('Provided fee is not enough. Probably it is a Gas Price spike, try to resubmit.')
  }
}

function getTxObject({ data }) {
  if (data.type === jobType.POOF_WITHDRAW || data.type === jobType.RELAY) {
    if (data.type === jobType.POOF_WITHDRAW) {
      return proxyContract.methods.withdraw(data.contract, data.proof, ...data.args)
    } else {
      const contract = new kit.web3.eth.Contract(tornadoABI, data.contract)
      return contract.methods.withdraw(data.proof, ...data.args)
    }
  } else if (data.type === jobType.WITHDRAW_V2) {
    const contract = new kit.web3.eth.Contract(poofABI, data.contract)
    return contract.methods.withdraw(data.proof, data.args)
  } else if (data.type === jobType.BATCH_REWARD) {
    return minerContract.methods.batchReward(data.rewardArgs)
  } else {
    const method = data.type === jobType.MINING_REWARD ? 'reward' : 'withdraw'
    return minerContract.methods[method](data.proof, data.args)
  }
}

async function isOutdatedTreeRevert(receipt, currentTx) {
  try {
    await kit.web3.eth.call(currentTx.tx, receipt.blockNumber)
    console.log('Simulated call successful')
    return false
  } catch (e) {
    console.log('Decoded revert reason:', e.message)
    return (
      e.message.indexOf('Outdated account merkle root') !== -1 ||
      e.message.indexOf('Outdated tree update merkle root') !== -1
    )
  }
}

async function processJob(job) {
  try {
    if (!jobType[job.data.type]) {
      throw new Error(`Unknown job type: ${job.data.type}`)
    }
    currentJob = job
    await updateStatus(status.ACCEPTED)
    console.log(`Start processing a new ${job.data.type} job #${job.id}`)
    await submitTx(job)
  } catch (e) {
    console.error('processJob', e.message)
    await updateStatus(status.FAILED)
    throw e
  }
}

async function submitTx(job, retry = 0) {
  await checkFee(job)
  currentTx = await getTxObject(job)

  const isWithdraw = job.data.type === jobType.POOF_WITHDRAW || job.data.type === jobType.RELAY
  if (!isWithdraw) {
    await fetchTree()
  }

  try {
    const receipt = await currentTx.send({
      from: account,
      gasPrice: toWei('0.13', 'gwei'),
      value: job.data.args[5],
    })
    await updateTxHash(receipt.transactionHash)
    console.log('Mined in block', receipt.blockNumber)

    if (receipt.status) {
      await updateStatus(status.CONFIRMED)
    } else {
      if (!isWithdraw && (await isOutdatedTreeRevert(receipt, currentTx))) {
        if (retry < 3) {
          await updateStatus(status.RESUBMITTED)
          await submitTx(job, retry + 1)
        } else {
          throw new Error('Tree update retry limit exceeded')
        }
      } else {
        throw new Error('Submitted transaction failed')
      }
    }
  } catch (e) {
    // todo this could result in duplicated error logs
    // todo handle a case where account tree is still not up to date (wait and retry)?
    if (
      !isWithdraw &&
      (e.message.indexOf('Outdated account merkle root') !== -1 ||
        e.message.indexOf('Outdated tree update merkle root') !== -1)
    ) {
      if (retry < 5) {
        await sleep(3000)
        console.log('Tree is still not up to date, resubmitting')
        await submitTx(job, retry + 1)
      } else {
        throw new Error('Tree update retry limit exceeded')
      }
    } else {
      throw new Error(`Revert by smart contract ${e.message}`)
    }
  }
}

async function updateTxHash(txHash) {
  console.log(`A new successfully sent tx ${txHash}`)
  currentJob.data.txHash = txHash
  await currentJob.update(currentJob.data)
}

async function updateConfirmations(confirmations) {
  console.log(`Confirmations count ${confirmations}`)
  currentJob.data.confirmations = confirmations
  await currentJob.update(currentJob.data)
}

async function updateStatus(status) {
  console.log(`Job status updated ${status}`)
  currentJob.data.status = status
  await currentJob.update(currentJob.data)
}

start()
