import type { FloorPlan } from '../types/model'
import e1 from './example1.json'
import e2 from './example2.json'
import e3 from './example3.json'
import e4 from './example4.json'

export interface ExamplePlan {
  name: string
  description: string
  plan: FloorPlan
}

interface ExampleFile {
  meta?: { name?: string; description?: string }
  [key: string]: unknown
}

/** Title/description come from the file's meta; the rest is the plan. */
const fromFile = (d: ExampleFile, fallback: string): ExamplePlan => {
  const { meta, ...plan } = d
  return {
    name: meta?.name || fallback,
    description: meta?.description ?? '',
    plan: plan as unknown as FloorPlan,
  }
}

/** Bundled example plans, copyable into the user's list from the main tab. */
export const EXAMPLE_PLANS: ExamplePlan[] = [
  fromFile(e1, '예제 1'),
  fromFile(e2, '예제 2'),
  fromFile(e3, '예제 3'),
  fromFile(e4, '예제 4'),
]
