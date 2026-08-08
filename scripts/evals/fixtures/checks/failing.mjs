import { check, report } from '../../../week-zero/lib/harness.mjs'
check('a true thing is true', true)
check('a false thing is false', false, 'deliberate — proves the gate bites')
report('failing fixture')
