import fs from 'fs'
import path from 'path'
import { groth16 } from 'snarkjs'
import { GasPrice, calculateFee } from '@cosmjs/stargate'

import { adaptToUncompressed } from '../vota/adapt'
import { fetchAllVotesLogs, fetchRound } from '../vota/indexer'
import { getContractSignerClient } from '../lib/client/utils'
import { maciParamsFromCircuitPower, ProofData, TaskAct } from '../types'
import { log } from '../log'

import { genMaciInputs } from '../operator/genInputs'

const zkeyPath = './zkey/'

const inputsPath = path.join(process.env.WORK_PATH, 'inputs')
if (!fs.existsSync(inputsPath)) {
  fs.mkdirSync(inputsPath)
}

interface AllData {
  result: string[]
  salt: string
  msg: ProofData[]
  tally: ProofData[]
}

export const tally: TaskAct = async (_, { id }: { id: string }) => {
  log('\n\n\ntally', id)
  const maciRound = await fetchRound(id)

  log('period:', maciRound.period)

  const now = Date.now()

  if (
    !['Voting', 'Processing', 'Tallying'].includes(maciRound.period) &&
    now < Number(maciRound.votingEnd) / 1e6
  ) {
    return { error: { msg: 'error status: not end' } }
  }

  /**
   * 主要和 vota 交互的对象
   */
  const maciClient = await getContractSignerClient(id)

  /**
   * 先结束当前 round
   */
  if (maciRound.period === 'Voting') {
    const spGasPrice = GasPrice.fromString('100000000000peaka')
    const spGfee = calculateFee(100000000, spGasPrice)
    const startProcessRes = await maciClient.startProcessPeriod(spGfee)

    log('startProcessRes', startProcessRes)
  }

  const params = maciParamsFromCircuitPower(maciRound.circuitPower)

  /**
   * 尝试查看本地是否已经生成了所有证明信息
   *
   * 如果没有，则下载合约记录并且生成
   */
  let allData: AllData | undefined
  const saveFile = path.join(inputsPath, id + '.json')
  if (fs.existsSync(saveFile)) {
    const file = fs.readFileSync(saveFile).toString()
    try {
      allData = JSON.parse(file)
    } catch {}
  }

  const mc = await maciClient.getProcessedMsgCount()
  const uc = await maciClient.getProcessedUserCount()

  /**
   * 如果线上还没有开始处理交易，则总是重新生成证明
   */
  if (Number(mc) === 0 && Number(uc) === 0) {
    allData = undefined
  }

  if (!allData) {
    const logs = await fetchAllVotesLogs(id)

    log('logs s-m-d', logs.signup.length, logs.msg.length, logs.dmsg.length)

    const maxVoteOptions = await maciClient.maxVoteOptions()
    const res = genMaciInputs(
      {
        ...params,
        coordPriKey: BigInt(process.env.COORDINATOR_PRI_KEY),
        maxVoteOptions: Number(maxVoteOptions),
      },
      {
        states: logs.signup.map((s) => ({
          idx: s.stateIdx,
          balance: BigInt(s.balance),
          pubkey: (s.pubKey.match(/\d+/g) || []).map((n: string) =>
            BigInt(n),
          ) as [bigint, bigint],
          c: [BigInt(s.d0), BigInt(s.d1), BigInt(s.d2), BigInt(s.d3)],
        })),
        messages: logs.msg.map((m) => ({
          idx: m.msgChainLength,
          msg: (m.message.match(/(?<=\()\d+(?=\))/g) || []).map((s) =>
            BigInt(s),
          ),
          pubkey: (m.encPubKey.match(/\d+/g) || []).map((n: string) =>
            BigInt(n),
          ) as [bigint, bigint],
        })),
        dmessages: logs.dmsg.map((m) => ({
          idx: m.dmsgChainLength,
          numSignUps: m.numSignUps,
          msg: (m.message.match(/(?<=\()\d+(?=\))/g) || []).map((s) =>
            BigInt(s),
          ),
          pubkey: (m.encPubKey.match(/\d+/g) || []).map((n: string) =>
            BigInt(n),
          ) as [bigint, bigint],
        })),
      },
      logs.ds.map((d) => d.map(BigInt)),
    )

    const lastTallyInput = res.tallyInputs[res.tallyInputs.length - 1]
    const result = res.result.map((i) => i.toString())
    const salt = lastTallyInput.newResultsRootSalt.toString()

    const msg: ProofData[] = []
    log('start to gen proof | msg')
    for (let i = 0; i < res.msgInputs.length; i++) {
      const input = res.msgInputs[i]

      const { proof } = await groth16.fullProve(
        input,
        zkeyPath + maciRound.circuitPower + '/msg.wasm',
        zkeyPath + maciRound.circuitPower + '/msg.zkey',
      )

      const proofHex = await adaptToUncompressed(proof)
      const commitment = input.newStateCommitment.toString()
      log('gen proof | msg | ' + i)
      msg.push({ proofHex, commitment })
    }

    const tally: ProofData[] = []
    log('start to gen proof | tally')
    for (let i = 0; i < res.tallyInputs.length; i++) {
      const input = res.tallyInputs[i]

      const { proof } = await groth16.fullProve(
        input,
        zkeyPath + maciRound.circuitPower + '/tally.wasm',
        zkeyPath + maciRound.circuitPower + '/tally.zkey',
      )

      const proofHex = await adaptToUncompressed(proof)
      const commitment = input.newTallyCommitment.toString()
      log('gen proof | tally | ' + i)
      tally.push({ proofHex, commitment })
    }

    allData = {
      result,
      salt,
      msg,
      tally,
    }

    fs.writeFileSync(saveFile, JSON.stringify(allData))
  }

  let mi = Math.ceil(Number(mc) / params.batchSize)

  log('prepare to send msg', mi)

  if (mi < allData.msg.length) {
    for (; mi < allData.msg.length; mi++) {
      const { proofHex, commitment } = allData.msg[mi]
      const res = await maciClient.processMessage({
        groth16Proof: proofHex,
        newStateCommitment: commitment,
      })
      log('processMessage', mi, res)
    }

    await maciClient.stopProcessingPeriod()
  } else {
    const period = await maciClient.getPeriod()
    if (period.status === 'processing') {
      await maciClient.stopProcessingPeriod()
    }
  }

  let ui = Math.ceil(Number(uc) / 5 ** params.intStateTreeDepth)

  log('prepare to send tally', ui)

  if (ui < allData.tally.length) {
    for (; ui < allData.tally.length; ui++) {
      const { proofHex, commitment } = allData.tally[ui]
      const res = await maciClient.processTally({
        groth16Proof: proofHex,
        newTallyCommitment: commitment,
      })
      log('processTally', ui, res)
    }

    await maciClient.stopTallyingPeriod({
      results: allData.result,
      salt: allData.salt,
    })
  } else {
    const period = await maciClient.getPeriod()
    if (period.status === 'tallying') {
      await maciClient.stopTallyingPeriod({
        results: allData.result,
        salt: allData.salt,
      })
    }
  }

  return {}
}
