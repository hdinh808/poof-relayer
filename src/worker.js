const fs = require('fs')
const Web3 = require('web3')
const { toBN, toWei, fromWei } = require('web3-utils')
const MerkleTree = require('fixed-merkle-tree')
const Redis = require('ioredis')
const { Controller: ControllerV1 } = require('tornado-cash-anonymity-mining')

const tornadoABI = require('../abis/tornadoABI.json')
const tornadoProxyABI = require('../abis/tornadoProxyABI.json')
const miningABI = require('../abis/mining.abi.json')
const swapABI = require('../abis/swap.abi.json')
const poofABI = require('../abis/poof.abi.json')
const { queue } = require('./queue')
const {
  poseidonHash2,
  poseidonHashTorn2,
  getInstance,
  fromDecimals,
  sleep,
} = require('./utils')
const { jobType, status } = require('./constants')
const {
  netId,
  poof,
  httpRpcUrl,
  redisUrl,
  privateKey,
  gasLimits,
  instances,
  poofServiceFee,
  miningServiceFee,
  pools,
  treeAddresses,
} = require('./config')
const {
  calculateFee,
  calculateRewardFee,
  calculateSwapFee,
} = require('@poofcash/poof-kit')
const {
  calculateFee: calculateFeeV2,
  Controller: ControllerV2,
} = require('@poofcash/poof-v2-kit')
const snarkjs = require('snarkjs-pkg')

let web3
let account
let currentTx
let currentJob
const trees = {}
let controllerV1, controllerV2
let swap
let minerContract
let proxyContract
const redis = new Redis(redisUrl)
const redisSubscribe = new Redis(redisUrl)

const getFetchTree = treeAddress => {
  return async function fetchTree() {
    const elements = await redis.get(`tree:${treeAddress}:elements`)
    const convert = (_, val) => (typeof val === 'string' ? toBN(val) : val)
    const isMiner = treeAddress === poof.PoofMiner.address
    trees[treeAddress] = MerkleTree.deserialize(
      JSON.parse(elements, convert),
      isMiner ? poseidonHashTorn2 : poseidonHash2,
    )

    // Check if there is a tx to replace
    if (currentTx && currentJob) {
      const { proof, args } = currentJob.data
      if (toBN(args.account.inputRoot).eq(toBN(trees[treeAddress].root()))) {
        console.log(
          'Account root is up to date. Skipping Root Update operation...',
        )
        return
      } else {
        console.log(
          'Account root is outdated. Starting Root Update operation...',
        )
      }

      if (
        isMiner &&
        ['MINING_REWARD', 'MINING_WITHDRAW'].includes(currentJob.data.type)
      ) {
        const update = await controllerV1.treeUpdate(
          args.account.outputCommitment,
          trees[treeAddress],
        )

        if (currentJob.data.type === 'MINING_REWARD') {
          currentTx = minerContract.methods.reward(
            proof,
            args,
            update.proof,
            update.args,
          )
        } else if (currentJob.data.type === 'MINING_WITHDRAW') {
          currentTx = minerContract.methods.withdraw(
            proof,
            args,
            update.proof,
            update.args,
          )
        }
        console.log('replaced pending mining tx')
      } else if (
        currentJob.data.contract.toLowerCase() === treeAddress.toLowerCase()
      ) {
        const contract = new web3.eth.Contract(poofABI, treeAddress)
        const update = await controllerV2.treeUpdate(
          contract,
          args.account.outputCommitment,
          trees[treeAddress],
        )

        if (currentJob.data.type === jobType.WITHDRAW_V2) {
          currentTx = contract.methods.withdraw(
            proof,
            args,
            update.proof,
            update.args,
          )
        } else if (currentJob.data.type === jobType.MINT_V2) {
          currentTx = contract.methods.mint(
            proof,
            args,
            update.proof,
            update.args,
          )
        }
        console.log('replaced pending v2 tx')
      }
    }
  }
}

async function start() {
  try {
    web3 = new Web3(httpRpcUrl)
    account = web3.eth.accounts.wallet.add(privateKey).address
    swap = new web3.eth.Contract(swapABI, poof.PoofRewardSwap.address)
    minerContract = new web3.eth.Contract(miningABI, poof.PoofMiner.address)
    proxyContract = new web3.eth.Contract(
      tornadoProxyABI,
      poof.PoofProxy.address,
    )
    for (const treeAddress of treeAddresses) {
      redisSubscribe.subscribe(
        `treeUpdate:${treeAddress}`,
        getFetchTree(treeAddress),
      )
      await getFetchTree(treeAddress)()
    }
    controllerV1 = new ControllerV1({
      provingKeys: {
        treeUpdateCircuit: require('../keys/TreeUpdate.json'),
        treeUpdateProvingKey: fs.readFileSync(
          './keys/TreeUpdate_proving_key.bin',
        ).buffer,
      },
    })
    await controllerV1.init()
    controllerV2 = new ControllerV2({
      snarkjs,
      provingKeys: {
        treeUpdateWasm: fs.readFileSync('./keys/TreeUpdate.wasm'),
        treeUpdateZkey: fs.readFileSync('./keys/TreeUpdate_circuit_final.zkey'),
      },
    })
    queue.process(processJob)
    console.log('Worker started')
  } catch (e) {
    console.error('error on start worker', e.message)
  }
}

function checkFee({ data }) {
  if ([jobType.POOF_WITHDRAW, jobType.RELAY].includes(data.type)) {
    return checkPoofFee(data)
  } else if (data.type === jobType.BATCH_REWARD) {
    return checkBatchMiningFee(data)
  } else if ([jobType.WITHDRAW_V2, jobType.MINT_V2].includes(data.type)) {
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
    throw new Error(
      'Provided fee is not enough. Probably it is a Gas Price spike, try to resubmit.',
    )
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
  const isMiningReward = ['MINING_REWARD', 'BATCH_REWARD'].includes(
    currentJob.data.type,
  )
  const providedFee = isMiningReward ? toBN(args.fee) : toBN(args.extData.fee)
  const balance = await swap.methods.poofVirtualBalance().call()
  const poolWeight = await swap.methods.poolWeight().call()

  let desiredFee
  if (isMiningReward) {
    desiredFee = calculateRewardFee(gasPrice, celoPrice, balance, poolWeight)
  } else {
    desiredFee = calculateSwapFee(
      gasPrice,
      celoPrice,
      balance,
      poolWeight,
      miningServiceFee,
      args.amount,
    )
  }

  console.log(
    'user provided fee, desired fee',
    providedFee.toString(),
    desiredFee.toString(),
  )
  if (providedFee.lt(desiredFee)) {
    throw new Error(
      'Provided fee is not enough. Probably it is a Gas Price spike, try to resubmit.',
    )
  }
}

async function checkWithdrawV2Fee({ args, contract }) {
  const { symbol, decimals } = pools[netId].find(
    entry => entry.poolAddress.toLowerCase() === contract.toLowerCase(),
  )
  const [fee, amount, debt] = [args.extData.fee, args.amount, args.debt].map(
    toBN,
  )

  const celoPrice = await redis.hget('prices', symbol.toLowerCase())
  const feePercent = toBN(fromDecimals(amount, decimals))
    .mul(toBN(poofServiceFee * 1e10))
    .div(toBN(1e10 * 100))
  const poof = new web3.eth.Contract(poofABI, contract)
  const unitPerUnderlying = await poof.methods.unitPerUnderlying().call()

  const desiredFee = calculateFeeV2(
    debt.mul(toBN(unitPerUnderlying)).add(amount).sub(fee),
    Number(celoPrice),
    Number(poofServiceFee),
    gasLimits[jobType.WITHDRAW_V2],
  )
  console.log(
    'sent fee, desired fee, feePercent',
    fromWei(fee.toString()),
    fromWei(desiredFee.toString()),
    fromWei(feePercent.toString()),
  )
  if (fee.lt(desiredFee)) {
    throw new Error(
      'Provided fee is not enough. Probably it is a Gas Price spike, try to resubmit.',
    )
  }
}

function getTxObject({ data }) {
  if ([jobType.POOF_WITHDRAW, jobType.RELAY].includes(data.type)) {
    if (data.type === jobType.POOF_WITHDRAW) {
      return proxyContract.methods.withdraw(
        data.contract,
        data.proof,
        ...data.args,
      )
    } else {
      const contract = new web3.eth.Contract(tornadoABI, data.contract)
      return contract.methods.withdraw(data.proof, ...data.args)
    }
  } else if (data.type === jobType.WITHDRAW_V2) {
    const contract = new web3.eth.Contract(poofABI, data.contract)
    return contract.methods.withdraw(data.proof, data.args)
  } else if (data.type === jobType.MINT_V2) {
    const contract = new web3.eth.Contract(poofABI, data.contract)
    return contract.methods.mint(data.proof, data.args)
  } else if (data.type === jobType.BATCH_REWARD) {
    return minerContract.methods.batchReward(data.rewardArgs)
  } else {
    const method = data.type === jobType.MINING_REWARD ? 'reward' : 'withdraw'
    return minerContract.methods[method](data.proof, data.args)
  }
}

async function isOutdatedTreeRevert(receipt, currentTx) {
  try {
    await web3.eth.call(currentTx.tx, receipt.blockNumber)
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

  const isWithdraw = [jobType.POOF_WITHDRAW, jobType.RELAY].includes(
    job.data.type,
  )
  const isV2 = [jobType.WITHDRAW_V2, jobType.MINT_V2].includes(job.data.type)

  if (!isWithdraw) {
    if (isV2) {
      await getFetchTree(job.data.contract)()
    } else {
      await getFetchTree(poof.PoofMiner.address)()
    }
  }

  const gasPrice = toWei((await redis.hget('gasPrices', 'min')) || 0.5, 'gwei')
  try {
    const gas = await currentTx.estimateGas({
      from: account,
      gasPrice,
      value: job.data.args[5],
    })
    const receipt = await currentTx.send({
      from: account,
      gasPrice,
      gas,
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
    console.warn('Submit tx error', e.message)
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
      console.error(e)
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
