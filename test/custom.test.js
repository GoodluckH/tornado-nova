const hre = require('hardhat')
const { ethers, waffle } = hre
const { loadFixture } = waffle
const { expect } = require('chai')
const { utils } = ethers

const Utxo = require('../src/utxo')
const { transaction, registerAndTransact, prepareTransaction, buildMerkleTree } = require('../src/index')
const { toFixedHex, poseidonHash } = require('../src/utils')
const { Keypair } = require('../src/keypair')
const { encodeDataForBridge } = require('./utils')

const MERKLE_TREE_HEIGHT = 5
const l1ChainId = 1
const MINIMUM_WITHDRAWAL_AMOUNT = utils.parseEther(process.env.MINIMUM_WITHDRAWAL_AMOUNT || '0.05')
const MAXIMUM_DEPOSIT_AMOUNT = utils.parseEther(process.env.MAXIMUM_DEPOSIT_AMOUNT || '1')

describe('custom test', function () {
  this.timeout(20000)

  async function deploy(contractName, ...args) {
    const Factory = await ethers.getContractFactory(contractName)
    const instance = await Factory.deploy(...args)
    return instance.deployed()
  }

  async function fixture() {
    require('../scripts/compileHasher')
    const [sender, gov, l1Unwrapper, multisig] = await ethers.getSigners()
    const verifier2 = await deploy('Verifier2')
    const verifier16 = await deploy('Verifier16')
    const hasher = await deploy('Hasher')

    const token = await deploy('PermittableToken', 'Wrapped ETH', 'WETH', 18, l1ChainId)
    await token.mint(sender.address, utils.parseEther('10000'))

    const amb = await deploy('MockAMB', gov.address, l1ChainId)
    const omniBridge = await deploy('MockOmniBridge', amb.address)

    /** @type {TornadoPool} */
    const tornadoPoolImpl = await deploy(
      'TornadoPool',
      verifier2.address,
      verifier16.address,
      MERKLE_TREE_HEIGHT,
      hasher.address,
      token.address,
      omniBridge.address,
      l1Unwrapper.address,
      gov.address,
      l1ChainId,
      multisig.address,
    )

    const { data } = await tornadoPoolImpl.populateTransaction.initialize(
      MINIMUM_WITHDRAWAL_AMOUNT,
      MAXIMUM_DEPOSIT_AMOUNT,
    )
    const proxy = await deploy(
      'CrossChainUpgradeableProxy',
      tornadoPoolImpl.address,
      gov.address,
      data,
      amb.address,
      l1ChainId,
    )

    const tornadoPool = tornadoPoolImpl.attach(proxy.address)

    await token.approve(tornadoPool.address, utils.parseEther('10000'))

    return { tornadoPool, token, proxy, omniBridge, amb, gov, multisig }
  }

  async function fixtureTree() {
    require('../scripts/compileHasher')
    const hasher = await deploy('Hasher')
    const merkleTreeWithHistory = await deploy(
      'MerkleTreeWithHistoryMock',
      MERKLE_TREE_HEIGHT,
      hasher.address,
    )
    await merkleTreeWithHistory.initialize()
    return { hasher, merkleTreeWithHistory }
  }

  it('should work', async function () {
    let { merkleTreeWithHistory } = await loadFixture(fixtureTree)

    console.log('estimate and print gas needed to insert a pair of leaves to MerkleTreeWithHistory')
    const gas = await merkleTreeWithHistory.estimateGas.hashLeftRight(toFixedHex(123), toFixedHex(456))
    console.log('hasher gas:', gas - 21000, '\n')

    console.log('deposit 0.08 ETH in L1\n')
    const { tornadoPool, token, omniBridge } = await loadFixture(fixture)
    const keypair = new Keypair() // contains private and public keys

    // deposit into Tornado pool
    const depositAmount = utils.parseEther('0.08')
    const depositUtxo = new Utxo({ amount: depositAmount, keypair: keypair })
    const { args, extData } = await prepareTransaction({
      tornadoPool,
      outputs: [depositUtxo],
    })

    const onTokenBridgedData = encodeDataForBridge({
      proof: args,
      extData,
    })

    const onTokenBridgedTx = await tornadoPool.populateTransaction.onTokenBridged(
      token.address,
      depositUtxo.amount,
      onTokenBridgedData,
    )

    //send tokens to the bridge which will then send L2 wrapped tokens to the poll
    await token.transfer(omniBridge.address, depositAmount)
    const transferTx = await token.populateTransaction.transfer(tornadoPool.address, depositAmount)

    // ask the omni bridge to execute the actions defined in populated transactions
    await omniBridge.execute([
      { who: token.address, callData: transferTx.data }, // from bridge tornado pool
      { who: tornadoPool.address, callData: onTokenBridgedTx.data }, // call onTokenBridgedTx
    ])

    console.log('withdraw 0.05 ETH in L2')
    const withdrawAmount = utils.parseEther('0.05')
    const recipient = '0xDeaD00000000000000000000000000000000BEEf'
    const changeUtxo = new Utxo({ amount: depositAmount.sub(withdrawAmount), keypair: keypair })

    await transaction({
      tornadoPool,
      inputs: [depositUtxo],
      outputs: [changeUtxo],
      recipient: recipient,
      isL1Withdrawal: false,
    })

    const recipientBalance = await token.balanceOf(recipient)
    expect(recipientBalance).to.be.equal(withdrawAmount)
    const omniBridgeBalance = await token.balanceOf(omniBridge.address)
    expect(omniBridgeBalance).to.be.equal(0)
  })
})
