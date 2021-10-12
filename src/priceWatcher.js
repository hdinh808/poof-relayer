const Redis = require('ioredis')
const { redisUrl, oracleRpcUrl, rceloAddress } = require('./config')
const { setSafeInterval } = require('./utils')
const redis = new Redis(redisUrl)
const { newKitFromWeb3, StableToken } = require('@celo/contractkit')
const { fromWei, toWei } = require('web3-utils')
const Web3 = require('web3')

const rceloABI = require('../abis/rcelo.abi.json')

const web3 = new Web3(
  new Web3.providers.HttpProvider(oracleRpcUrl, {
    timeout: 200000, // ms
  }),
)
const kit = newKitFromWeb3(web3)

async function main() {
  try {
    // TODO: poof price, rcelo price
    const oneEth = toWei('1')

    // Get cUSD price in CELO
    const exchangeUSD = await kit.contracts.getExchange(StableToken.cUSD)
    const exchangeEUR = await kit.contracts.getExchange(StableToken.cEUR)
    const cusdPrice = Number(
      fromWei((await exchangeUSD.quoteGoldBuy(oneEth)).toString()),
    )
    const ceurPrice = Number(
      fromWei((await exchangeEUR.quoteGoldBuy(oneEth)).toString()),
    )

    // get rCELO price in CELO
    const rCELO = new kit.web3.eth.Contract(
      rceloABI,
      '0x1a8Dbe5958c597a744Ba51763AbEBD3355996c3e',
    )
    const rceloPrice = Number(
      fromWei((await rCELO.methods.savingsToCELO(oneEth).call()).toString()),
    )

    const celoPrices = {
      celo: 1.0,
      poof: 1.0,
      rcelo: rceloPrice,
      cusd: cusdPrice,
      ceur: ceurPrice,
    }

    await redis.hmset('prices', celoPrices)
    console.log('Wrote following prices to redis', celoPrices)
  } catch (e) {
    console.error('priceWatcher error', e)
  }
}

setSafeInterval(main, 30 * 1000)
