// import fs from 'fs'
import _ from 'lodash'
// import { Secp256k1HdWallet } from '@cosmjs/launchpad'

import { Task, TaskResult } from './types'
import * as T from './task'

import { TestStorage } from './storage/TestStorage'
// import { genKeypair } from './lib/keypair'
import { log } from './log'
// import { getWallet } from './wallet'

import { init } from './init'

const DefaultTask: Task = { name: 'inspect' }

const sleep = async (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(() => {
      resolve()
    }, ms)
  })

let prevTaskName = ''

if (!process.env.COORDINATOR_PRI_KEY) {
  console.log('[ERROR] empty COORDINATOR_PRI_KEY in .env file!')
  process.exit(1)
}

const main = async () => {
  await init()

  const storage = new TestStorage()

  const tasks: Task[] = []

  const doTack = (task: Task) => {
    switch (task.name) {
      case 'deactivate':
        return T.deactivate(storage, task.params)
      case 'tally':
        return T.tally(storage, task.params)
      // case 'proof':
      //   return T.proof(storage, task.params)
      // case 'txProof':
      //   return T.txProof(storage, task.params)
      // case 'txStopVoting':
      //   return T.txStopVoting(storage, task.params)
      // case 'txResult':
      //   return T.txResult(storage, task.params)
      case 'inspect':
      default:
        return T.inspect(storage)
    }
  }

  while (true) {
    const task = tasks.shift() || DefaultTask

    if (task.name === 'inspect' && prevTaskName === 'inspect') {
      await sleep(60000)
    }
    prevTaskName = task.name

    const msg =
      '[DO]: ' +
      task.name +
      (task.params?.id ? ' - MACI Round ' + task.params.id : '')
    console.log(msg)
    log(msg)

    const { newTasks, error } = await doTack(task).catch((err): TaskResult => {
      log(err)
      return {
        error: { msg: err.message },
      }
    })

    if (newTasks) {
      for (const nt of newTasks) {
        if (!tasks.find((t) => _.isEqual(t, nt))) {
          tasks.push(nt)
        }
      }
    }

    if (error) {
      console.log('Task Error,', error.msg)
      if (typeof error.again === 'number') {
        tasks.splice(error.again, 0, task)
      }
    }

    await sleep(1000)
  }
}

main()
