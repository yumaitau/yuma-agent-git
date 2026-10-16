/** Work queue wire contracts (issue #59) shared by the browser and Worker. */
export const READINESS = [
  'draft',
  'needs-prep',
  'ready',
  'claimed',
  'in-review',
  'blocked',
  'done',
] as const;
export type Readiness = (typeof READINESS)[number];
export const RISKS = ['low', 'medium', 'high'] as const;
export type Risk = (typeof RISKS)[number];
export const SIZES = ['xs', 's', 'm', 'l', 'xl'] as const;
export type Size = (typeof SIZES)[number];

export interface WorkItem {
  /** The issue number in its repo. */
  number: number;
  title: string;
  state: 'open' | 'closed';
  readiness: Readiness;
  risk: Risk;
  size: Size | null;
  agent_kind: string | null;
  priority: number;
  plan: boolean;
  ready_at: number | null;
  /** `user:<id>`, `agent:<agent id>` or `agent:<token id>` while claimed. */
  claimed_by: string | null;
  lease_expires_at: number | null;
  attempts: number;
  /** Issue numbers this item waits on, and which of them are still open. */
  depends_on: number[];
  waiting_on: number[];
  updated_at: number;
}

export interface WorkEvent {
  id: number;
  actor: string;
  kind: string;
  from_readiness: Readiness | null;
  to_readiness: Readiness | null;
  reason: string | null;
  created_at: number;
}
