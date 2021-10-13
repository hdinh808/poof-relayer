mkdir -p keys

if [ ! -f keys/TreeUpdate_circuit_final.zkey ]; then
  wget https://poof.nyc3.digitaloceanspaces.com/TreeUpdate_circuit_final.zkey.gz -O keys/TreeUpdate_circuit_final.zkey.gz
  gunzip keys/TreeUpdate_circuit_final.zkey.gz
fi

if [ ! -f keys/TreeUpdate.wasm ]; then
  wget https://poof.nyc3.digitaloceanspaces.com/TreeUpdate.wasm.gz -O keys/TreeUpdate.wasm.gz
  gunzip keys/TreeUpdate.wasm.gz
fi

if [ ! -f keys/TreeUpdate.json ]; then
  wget https://poof.nyc3.digitaloceanspaces.com/TreeUpdate.json.gz -O keys/TreeUpdate.json.gz
  gunzip keys/TreeUpdate.json.gz
fi

if [ ! -f keys/TreeUpdate_proving_key.bin ]; then
  wget https://poof.nyc3.digitaloceanspaces.com/TreeUpdate_proving_key.bin.gz -O keys/TreeUpdate_proving_key.bin.gz
  gunzip keys/TreeUpdate_proving_key.bin.gz
fi
