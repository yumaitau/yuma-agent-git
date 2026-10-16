/** Issue wire contracts (issue #38) shared by the browser and Worker. */
export type IssueState = 'open' | 'closed';
export type StateReason = 'completed' | 'not_planned' | 'duplicate' | 'reopened';

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}
export interface Milestone {
  id: number;
  title: string;
  description: string;
  due_at: number | null;
  state: IssueState;
  created_at: number;
}
export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: IssueState;
  state_reason: StateReason | null;
  author_id: string;
  milestone_id: number | null;
  locked: boolean;
  pinned: boolean;
  created_at: number;
  updated_at: number;
  closed_at: number | null;
  labels: Label[];
  /** `user:<id>`, `team:<id>` or `agent:<token id>`. */
  assignees: string[];
  /** Sub-issue progress ("3 of 5 done"). */
  sub_issues: { total: number; done: number };
}
export interface IssueComment {
  id: number;
  author_id: string;
  body: string;
  created_at: number;
  updated_at: number;
}
export interface IssueEvent {
  id: number;
  actor: string;
  kind: string;
  payload: Record<string, unknown>;
  created_at: number;
}
export interface IssueSummary {
  number: number;
  title: string;
  state: IssueState;
}
export interface IssueDetail {
  issue: Issue;
  comments: IssueComment[];
  events: IssueEvent[];
  parent: IssueSummary | null;
  sub_issues: IssueSummary[];
  milestone: Milestone | null;
  /** The caller may label, assign, close, lock and order sub-issues. */
  can_triage: boolean;
  /** Display names for principals on the page (logins, `org/team`). */
  names: Record<string, string>;
}
export interface IssueTemplateField {
  type: 'markdown' | 'textarea' | 'input' | 'dropdown' | 'checkboxes';
  id: string;
  label: string;
  description: string;
  placeholder: string;
  value: string;
  options: string[];
  required: boolean;
}
export interface IssueTemplate {
  path: string;
  name: string;
  about: string;
  title: string;
  labels: string[];
  assignees: string[];
  /** Markdown templates: the starting body. Forms: empty. */
  body: string;
  /** Issue forms (`.yml`): the fields to render. Markdown templates: empty. */
  fields: IssueTemplateField[];
}
