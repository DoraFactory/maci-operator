declare global {
  namespace NodeJS {
    type ProcessEnv = {
      COORDINATOR_PRI_KEY: string

      RPC_ENDPOINT: string
      IND_ENDPOINT: string
      DEACTIVATE_RECORDER: string
      DEACTIVATE_INTERVAL: string
      CODE_IDS: string[]

      WORK_PATH: string

      MNEMONIC: string
      PRIVATE: string
    }
  }
}

export {}
