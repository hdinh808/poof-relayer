const MerkleTree = require('fixed-merkle-tree')
const { redisUrl, wsRpcUrl, treeAddresses, poof } = require('./config')
const { poseidonHash2, poseidonHashTorn2 } = require('./utils')
const { toBN } = require('web3-utils')
const Redis = require('ioredis')
const redis = new Redis(redisUrl)
const Web3 = require('web3')
const wsUrlPool = wsRpcUrl.split(',')
const PoofABI = require('../abis/poof.abi.json')

let wsIdx = 0
let web3

const trees = {}
const eventSubscriptions = {}
const blockSubscriptions = {}

// todo handle the situation when we have two rewards in one block
async function fetchEvents(contract, from = 0, to = 'latest') {
  try {
    const start = from
    const end = to === 'latest' ? await web3.eth.getBlockNumber() : to
    const bucketSize = 100_000
    const events = []
    for (
      let i = Math.floor(start / bucketSize);
      i < Math.ceil(end / bucketSize);
      i++
    ) {
      events.push(
        ...(await contract.getPastEvents('NewAccount', {
          fromBlock: Math.max(i * bucketSize, start),
          toBlock: Math.min((i + 1) * bucketSize, end),
        })),
      )
    }
    return events
      .sort((a, b) => a.returnValues.index - b.returnValues.index)
      .map(e => toBN(e.returnValues.commitment))
  } catch (e) {
    console.error('error fetching events', e)
  }
}

const getProcessNewEvent = contract => {
  return async function processNewEvent(err, event) {
    if (err) {
      throw new Error(`Event handler error: ${err}`)
      // console.error(err)
      // return
    }

    console.log(
      `New account event
     Contract: ${contract.options.address}
     Index: ${event.returnValues.index}
     Commitment: ${event.returnValues.commitment}
     Nullifier: ${event.returnValues.nullifier}
     EncAcc: ${event.returnValues.encryptedAccount}`,
    )
    const treeAddress = contract.options.address
    const { commitment, index } = event.returnValues
    if (trees[treeAddress].elements().length === Number(index)) {
      trees[treeAddress].insert(toBN(commitment))
      await updateRedis(contract)
    } else if (trees[treeAddress].elements().length === Number(index) + 1) {
      console.log('Replacing element', index)
      trees[treeAddress].update(index, toBN(commitment))
      await updateRedis(contract)
    } else {
      console.log(`Invalid element index ${index}, rebuilding tree`)
      await rebuild()
    }
  }
}

const getProcessNewBlock = contract => {
  return async function processNewBlock(err) {
    if (err) {
      throw new Error(`Event handler error: ${err}`)
      // console.error(err)
      // return
    }
    // what if updateRedis takes more than 5 sec?
    await updateRedis(contract)
  }
}

async function updateRedis(contract) {
  const rootOnContract = await contract.methods.getLastAccountRoot().call()
  const treeAddress = contract.options.address
  if (!trees[treeAddress].root().eq(toBN(rootOnContract))) {
    console.log(
      `Invalid tree root: ${trees[treeAddress].root()} != ${toBN(
        rootOnContract,
      )}, rebuilding tree`,
    )
    await rebuild(contract)
    return
  }
  const rootInRedis = await redis.get(`tree:${treeAddress}:root`)
  if (!rootInRedis || !trees[treeAddress].root().eq(toBN(rootInRedis))) {
    const serializedTree = JSON.stringify(trees[treeAddress].serialize())
    await redis.set(`tree:${treeAddress}:elements`, serializedTree)
    await redis.set(
      `tree:${treeAddress}:root`,
      trees[treeAddress].root().toString(),
    )
    await redis.publish(
      `treeUpdate:${treeAddress}`,
      trees[treeAddress].root().toString(),
    )
    console.log(
      'Updated tree in redis, new root:',
      trees[treeAddress].root().toString(),
    )
  }
  await redis.hset('treeV2WatcherHealth', { status: true, error: '' })
}

async function rebuild(contract) {
  const treeAddress = contract.options.address
  await eventSubscriptions[treeAddress].unsubscribe()
  await blockSubscriptions[treeAddress].unsubscribe()
  setTimeout(getInit(treeAddress), 3000)
}

function initWeb3() {
  const url = wsUrlPool[wsIdx]
  web3 = new Web3(
    new Web3.providers.WebsocketProvider(url, {
      clientConfig: {
        maxReceivedFrameSize: 100000000,
        maxReceivedMessageSize: 100000000,
      },
    }),
  )
  console.log('web3 url', url)
  wsIdx = (wsIdx + 1) % wsUrlPool.length
}

const getInit = treeAddress => {
  return async function init() {
    try {
      console.log(`Initializing v2 tree updater for ${treeAddress}`)

      const block = await web3.eth.getBlockNumber()
      const contract = new web3.eth.Contract(PoofABI, treeAddress)
      const events = await fetchEvents(contract, 0, block)
      // TODO: HARDCODED 20
      trees[treeAddress] = new MerkleTree(20, events, {
        hashFunction:
          treeAddress === poof.PoofMiner.address
            ? poseidonHashTorn2
            : poseidonHash2,
      })
      console.log(
        `Rebuilt tree ${treeAddress} with ${
          events.length
        } elements, root: ${trees[treeAddress].root()}`,
      )
      eventSubscriptions[treeAddress] = contract.events.NewAccount(
        { fromBlock: block + 1 },
        getProcessNewEvent(contract),
      )
      blockSubscriptions[treeAddress] = web3.eth.subscribe(
        'newBlockHeaders',
        getProcessNewBlock(contract),
      )
      await updateRedis(contract)
    } catch (e) {
      console.error('error on init treeWatcher', e.message)
      setTimeout(init, 3000)
    }
  }
}

initWeb3()
for (const treeAddress of treeAddresses) {
  getInit(treeAddress)()
}

process.on('unhandledRejection', error => {
  console.error('Unhandled promise rejection', error)
  redis.hset('treeV2WatcherHealth', { status: false, error: error.message })
  process.exit(1)
})
