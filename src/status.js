const queue = require('./queue')
const {netId, poofServiceFee, miningServiceFee, instances, redisUrl, rewardAccount} = require('./config')
const {version} = require('../package.json')
const Redis = require('ioredis')
const redis = new Redis(redisUrl)

async function status(req, res) {
  const celoPrices = await redis.hgetall('prices')
  const health = await redis.hgetall('health')
  const treeWatcherHealth = await redis.hgetall('treeWatcherHealth')
  const gasPrices = await redis.hgetall('gasPrices')

  const {waiting: currentQueue} = await queue.queue.getJobCounts()

  res.json({
    rewardAccount,
    instances: instances[`netId${netId}`],
    netId,
    celoPrices,
    gasPrices,
    poofServiceFee,
    miningServiceFee,
    version,
    health,
    treeWatcherHealth,
    currentQueue,
  })
}

function index(req, res) {
  res.send(
    'This is a <a href=https://poof.cash>poof.cash</a> Relayer service. Check the <a href=/v1/status>/status</a> for settings',
  )
}

async function getJob(req, res) {
  const status = await queue.getJobStatus(req.params.id)
  return status ? res.json(status) : res.status(400).json({error: "The job doesn't exist"})
}

module.exports = {
  status,
  index,
  getJob,
}
