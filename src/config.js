require('dotenv').config()

const { jobType } = require('./constants')
const {
  deployments,
  alfajoresAddresses,
  mainnetAddresses,
} = require('@poofcash/poof-kit')
const { deployments: v2Deployments } = require('@poofcash/poof-v2-kit')

const netId = Number(process.env.NET_ID) || 42220
const poof = netId === 42220 ? mainnetAddresses : alfajoresAddresses
const pools = v2Deployments
const treeAddresses = [
  ...pools[netId].map(p => p.poolAddress),
  ...(netId === 42220 ? [poof.PoofMiner.address] : []),
]

module.exports = {
  netId,
  redisUrl: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
  httpRpcUrl: process.env.HTTP_RPC_URL,
  wsRpcUrl: process.env.WS_RPC_URL,
  oracleRpcUrl: process.env.ORACLE_RPC_URL || 'https://mainnet.infura.io/',
  offchainOracleAddress: '0x080AB73787A8B13EC7F40bd7d00d6CC07F9b24d0',
  minerMerkleTreeHeight: 20,
  privateKey: process.env.PRIVATE_KEY,
  instances: deployments,
  poof,
  port: process.env.PORT || 8000,
  poofServiceFee: Number(process.env.REGULAR_POOF_WITHDRAW_FEE),
  miningServiceFee: Number(process.env.MINING_SERVICE_FEE),
  rewardAccount: process.env.REWARD_ACCOUNT,
  gasLimits: {
    [jobType.POOF_WITHDRAW]: 350000,
    [jobType.MINING_REWARD]: 455000,
    [jobType.MINING_WITHDRAW]: 400000,
    [jobType.WITHDRAW_V2]: 1e6,
  },
  minimumBalance: '1000000000000000000',
  pools,
  treeAddresses,
}
