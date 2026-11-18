// Registers load-hooks.mjs for the process it is imported into (node --import ./test/helpers/load-register.mjs).
import { register } from 'node:module'

register('./load-hooks.mjs', import.meta.url)
