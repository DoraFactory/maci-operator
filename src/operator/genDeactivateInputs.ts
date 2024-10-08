import { DMsgInput, MACI } from '../lib/Maci'
import { IContractLogs } from '../types'

interface IGenMaciInputsParams {
  stateTreeDepth: number
  intStateTreeDepth: number
  voteOptionTreeDepth: number
  batchSize: number
  coordPriKey: bigint
  maxVoteOptions: number
}

export const genDeacitveMaciInputs = (
  {
    stateTreeDepth,
    intStateTreeDepth,
    voteOptionTreeDepth,
    batchSize,
    coordPriKey,
    maxVoteOptions,
  }: IGenMaciInputsParams,
  contractLogs: IContractLogs,
  // deactivates: bigint[][],
  deactivateSize: number,
) => {
  const maci = new MACI(
    stateTreeDepth,
    intStateTreeDepth,
    voteOptionTreeDepth,
    batchSize,
    coordPriKey,
    maxVoteOptions,
    contractLogs.states.length,
    false, // 处理 deacitvate 的时候不需要关心 isQuadraticCost 的状态
  )

  for (const state of contractLogs.states) {
    maci.initStateTree(state.idx, state.pubkey, state.balance, state.c)
  }

  for (const msg of contractLogs.dmessages) {
    maci.pushDeactivateMessage(msg.msg, msg.pubkey)
  }

  // maci.uploadDeactivateHistory(deactivates, contractLogs.states.length)

  let i = 0
  while (maci.processedDMsgCount < deactivateSize) {
    let size = maci.batchSize
    if (size + i > deactivateSize) {
      size = deactivateSize - i
    }
    i = i + size

    maci.processDeactivateMessage(
      size,
      contractLogs.dmessages[i - 1].numSignUps,
    )
  }

  const newDeactivates: bigint[][] = []
  // PROCESSING
  i = maci.processedDMsgCount
  const dMsgInputs: { input: DMsgInput; size: string }[] = []
  while (maci.processedDMsgCount < contractLogs.dmessages.length) {
    let size = maci.batchSize
    if (size + i > contractLogs.dmessages.length) {
      size = contractLogs.dmessages.length - i
    }
    i = i + size

    const { input, newDeactivate } = maci.processDeactivateMessage(
      size,
      contractLogs.dmessages[i - 1].numSignUps,
    )

    newDeactivates.push(...newDeactivate)
    dMsgInputs.push({ input, size: size.toString() })
  }

  return {
    dMsgInputs,
    newDeactivates,
  }
}
