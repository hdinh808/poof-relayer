# Relayer for Poof Cash

## Getting listed on app.poof.cash

If you would like to be listed in poof.cash UI relayer's dropdown option, see the [interface repo](https://github.com/poofcash/poofcash)

## Deploy with docker-compose

docker-compose.test.yml contains a stack that will run the relayer locally on port 8000

docker-compose.yml contains a stack that will automatically provision SSL certificates for your domain name and will add a https redirect to port 80.

1. Download [docker-compose.yml](/docker-compose.yml) and [.env.example](/.env.example)

```
# wget https://raw.githubusercontent.com/poofcash/poof-relayer/mainnet/docker-compose.test.yml
wget https://raw.githubusercontent.com/poofcash/poof-relayer/mainnet/docker-compose.yml
wget https://raw.githubusercontent.com/poofcash/poof-relayer/mainnet/.env.example -O .env
```

2. Setup environment variables

   - set `NET_ID` (42220 for mainnet, 44787 for Alfajores)
   - set `HTTP_RPC_URL` rpc url for your celo node. E.g. https://forno.celo.org
   - set `WS_RPC_URL` websocket url. E.g. wss://forno.celo.org/ws (additional fallback urls may be added, separated by commas)
   - set `ORACLE_RPC_URL` - rpc url for mainnet node for fetching prices (always have to be on mainnet). E.g. https://forno.celo.org
   - set `PRIVATE_KEY` for your relayer address (without 0x prefix)
   - set `VIRTUAL_HOST` and `LETSENCRYPT_HOST` to your domain and add DNS record pointing to your relayer ip address
   - set `REGULAR_POOF_WITHDRAW_FEE` - fee in % that is used for Poof privacy contract withdrawals. E.g. 0.01 is a 0.01% fee
   - set `MINING_SERVICE_FEE` - fee in % that is used for mining AP withdrawals. E.g. 0.01 is a 0.01% fee
   - set `REWARD_ACCOUNT` - celo address that is used to collect fees.
   - update `AGGREGATOR` if needed - Contract address of aggregator instance.
   - update `CONFIRMATIONS` if needed - how many block confirmations to wait before processing an event. Not recommended to set less than 3
   - update `MAX_GAS_PRICE` if needed - maximum value of gwei value for relayer's transaction

     If you want to use more than 1 celo address for relaying transactions, please add as many `workers` as you want. For example, you can comment out `worker2` in docker-compose.yml file, but please use a different `PRIVATE_KEY` for each worker.

3. Run `docker-compose up -d`

## Run locally

1. `npm i`
2. `cp .env.example .env`
3. Modify `.env` as needed
4. `npm run start`
5. Go to `http://127.0.0.1:8000`
6. In order to execute withdraw request, you can run following command

```bash
curl -X POST -H 'content-type:application/json' --data '<input data>' http://127.0.0.1:8000/relay
```

Relayer should return a transaction hash

In that case you will need to add https termination yourself because browsers with default settings will prevent https
poof.cash UI from submitting your request over http connection

## Architecture

1. TreeWatcher module keeps track of Account Tree changes and automatically caches the actual state in Redis and emits `treeUpdate` event to redis pub/sub channel
2. Server module is Express.js instance that accepts http requests
3. Controller contains handlers for the Server endpoints. It validates input data and adds a Job to Queue.
4. Queue module is used by Controller to put and get Job from queue (bull wrapper)
5. Status module contains handler to get a Job status. It's used by UI for pull updates
6. Validate contains validation logic for all endpoints
7. Worker is the main module that gets a Job from queue and processes it

Disclaimer:

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
