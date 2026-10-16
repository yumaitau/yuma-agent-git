import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  api,
  asApiError,
  type ApiError,
  type Org,
  type OrgBaseRole,
  type OrgMember,
  type OrgRole,
  type Repo,
  type Team,
  type TeamDetail,
} from '../api';
import { useToast } from '../toast';
import { Chip, Empty, ErrorNotice, Field, Loading } from '../ui';
import { AgentPausePanel } from './Guardrails';

/**
 * Organisation settings (issue #26): members and org roles, base role,
 * teams (nested via a parent team), team repo grants and the agent kill
 * switch (#62). `/orgs` lists the caller's orgs and creates new ones;
 * `/orgs/:org` manages one org.
 */

const ORG_ROLES: OrgRole[] = ['member', 'admin', 'owner', 'billing'];
const BASE_ROLES: OrgBaseRole[] = ['none', 'read', 'write', 'admin'];
const REPO_ROLES = ['read', 'write', 'admin'] as const;

function OrgIndex(): ReactElement {
  const toast = useToast();
  const navigate = useNavigate();
  const [orgs, setOrgs] = useState<(Org & { role: OrgRole })[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [slug, setSlug] = useState('');

  useEffect(() => {
    api
      .listOrgs()
      .then(setOrgs)
      .catch((err) => setError(asApiError(err)));
  }, []);

  const create = useCallback(async () => {
    try {
      const org = await api.createOrg({ slug: slug.trim() });
      toast.show(`organisation ${org.slug} created`);
      navigate(`/orgs/${org.slug}`);
    } catch (err) {
      toast.showError(err);
    }
  }, [slug, toast, navigate]);

  return (
    <div>
      <h1>Organisations</h1>
      {error && <ErrorNotice error={error} />}
      <div className="panel">
        <h2>Your organisations</h2>
        {orgs === null ? (
          !error && <Loading />
        ) : orgs.length === 0 ? (
          <Empty>You are not in any organisation yet.</Empty>
        ) : (
          <ul>
            {orgs.map((o) => (
              <li key={o.id}>
                <Link to={`/orgs/${o.slug}`}>{o.slug}</Link> <Chip>{o.role}</Chip>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="panel">
        <h2>New organisation</h2>
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <Field label="Organisation slug">
            <input
              type="text"
              placeholder="yuma"
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
            />
          </Field>
          <button
            className="primary"
            disabled={slug.trim() === ''}
            onClick={() => void create()}
          >
            Create organisation
          </button>
        </div>
        <div className="small faint" style={{ marginTop: 6 }}>
          Lowercase letters, digits and single hyphens, up to 39 characters. You become
          the owner.
        </div>
      </div>
    </div>
  );
}

function TeamPanel({
  org,
  team,
  repos,
  canManage,
}: {
  org: string;
  team: string;
  repos: Repo[];
  canManage: boolean;
}): ReactElement {
  const toast = useToast();
  const [detail, setDetail] = useState<TeamDetail | null>(null);
  const [login, setLogin] = useState('');
  const [repo, setRepo] = useState('');
  const [role, setRole] = useState<(typeof REPO_ROLES)[number]>('read');

  const load = useCallback(() => {
    api
      .getTeam(org, team)
      .then(setDetail)
      .catch((err) => toast.showError(err));
  }, [org, team, toast]);
  useEffect(load, [load]);

  const act = useCallback(
    async (fn: () => Promise<void>) => {
      try {
        await fn();
        load();
      } catch (err) {
        toast.showError(err);
      }
    },
    [load, toast],
  );

  if (detail === null) return <Loading />;
  return (
    <div className="panel tight">
      <h3>
        Team {detail.team.slug}
        {detail.team.parent && (
          <span className="small muted"> (inherits from {detail.team.parent})</span>
        )}
      </h3>
      <table>
        <thead>
          <tr>
            <th>Member</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {detail.members.map((m) => (
            <tr key={m.user_id}>
              <td>{m.login ?? m.user_id}</td>
              <td>
                {canManage && (
                  <button
                    className="danger"
                    onClick={() =>
                      void act(() => api.deleteTeamMember(org, team, m.user_id))
                    }
                  >
                    Remove
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {canManage && (
        <div className="row" style={{ alignItems: 'flex-end', marginTop: 8 }}>
          <Field label="Add member (GitHub login)">
            <input type="text" value={login} onChange={(e) => setLogin(e.target.value)} />
          </Field>
          <button
            disabled={login.trim() === ''}
            onClick={() =>
              void act(async () => {
                await api.putTeamMember(org, team, login.trim());
                setLogin('');
              })
            }
          >
            Add to team
          </button>
        </div>
      )}
      <table style={{ marginTop: 10 }}>
        <thead>
          <tr>
            <th>Repository</th>
            <th>Role</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {detail.repos.map((g) => (
            <tr key={g.repo}>
              <td>
                <Link to={`/r/${g.repo}`}>{g.repo}</Link>
              </td>
              <td>
                <Chip>{g.role}</Chip>
              </td>
              <td>
                {canManage && (
                  <button
                    className="danger"
                    onClick={() => void act(() => api.deleteTeamRepo(org, team, g.repo))}
                  >
                    Revoke
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {canManage && (
        <div className="row" style={{ alignItems: 'flex-end', marginTop: 8 }}>
          <Field label="Grant repository">
            <select value={repo} onChange={(e) => setRepo(e.target.value)}>
              <option value="">select a repo…</option>
              {repos.map((r) => (
                <option key={r.id} value={r.slug}>
                  {r.slug}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Team role">
            <select value={role} onChange={(e) => setRole(e.target.value as typeof role)}>
              {REPO_ROLES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </Field>
          <button
            disabled={repo === ''}
            onClick={() => void act(() => api.putTeamRepo(org, team, { repo, role }))}
          >
            Grant
          </button>
        </div>
      )}
    </div>
  );
}

function OrgDetail({ slug }: { slug: string }): ReactElement {
  const toast = useToast();
  const [org, setOrg] = useState<Org | null>(null);
  const [role, setRole] = useState<OrgRole | null>(null);
  const [members, setMembers] = useState<OrgMember[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [error, setError] = useState<ApiError | null>(null);
  const [selected, setSelected] = useState('');
  const [memberLogin, setMemberLogin] = useState('');
  const [memberRole, setMemberRole] = useState<OrgRole>('member');
  const [teamSlug, setTeamSlug] = useState('');
  const [teamParent, setTeamParent] = useState('');

  const load = useCallback(() => {
    setError(null);
    Promise.all([
      api.getOrg(slug),
      api.listOrgMembers(slug),
      api.listTeams(slug),
      api.listOrgRepos(slug),
    ])
      .then(([o, m, t, r]) => {
        setOrg(o.org);
        setRole(o.role);
        setMembers(m);
        setTeams(t);
        setRepos(r);
      })
      .catch((err) => setError(asApiError(err)));
  }, [slug]);
  useEffect(load, [load]);

  const act = useCallback(
    async (fn: () => Promise<unknown>, done: string) => {
      try {
        await fn();
        toast.show(done);
        load();
      } catch (err) {
        toast.showError(err);
      }
    },
    [load, toast],
  );

  if (error) return <ErrorNotice error={error} />;
  if (org === null || role === null) return <Loading />;
  const isOwner = role === 'owner';
  const canManage = isOwner || role === 'admin';

  return (
    <div>
      <h1>{org.display_name}</h1>
      <div className="small muted">
        <code>{org.slug}</code> · your role <Chip kind="info">{role}</Chip>
      </div>

      <AgentPausePanel org={org.slug} canManage={canManage} />

      <div className="panel">
        <h2>Base permissions</h2>
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <Field label="Base role for members">
            <select
              value={org.base_role}
              disabled={!isOwner}
              onChange={(e) =>
                void act(
                  () => api.updateOrg(slug, { base_role: e.target.value as OrgBaseRole }),
                  'base role updated',
                )
              }
            >
              {BASE_ROLES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </Field>
          <label className="row">
            <input
              type="checkbox"
              checked={org.members_can_create_repos}
              disabled={!isOwner}
              onChange={(e) =>
                void act(
                  () =>
                    api.updateOrg(slug, { members_can_create_repos: e.target.checked }),
                  'repo creation setting updated',
                )
              }
            />
            Members can create repositories
          </label>
        </div>
        <div className="small faint" style={{ marginTop: 6 }}>
          Owners are admins on every org repository. Path rules still deny access that a
          role or team grant would allow.
        </div>
      </div>

      <div className="panel">
        <h2>Members</h2>
        <table>
          <thead>
            <tr>
              <th>Member</th>
              <th>Role</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.user_id}>
                <td>{m.login ?? m.user_id}</td>
                <td>
                  <Chip kind={m.role === 'owner' ? 'info' : 'default'}>{m.role}</Chip>
                </td>
                <td>
                  {canManage && (
                    <button
                      className="danger"
                      onClick={() =>
                        void act(
                          () => api.deleteOrgMember(slug, m.user_id),
                          'member removed',
                        )
                      }
                    >
                      Remove
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {canManage && (
          <div className="row" style={{ alignItems: 'flex-end', marginTop: 10 }}>
            <Field label="GitHub login">
              <input
                type="text"
                value={memberLogin}
                onChange={(e) => setMemberLogin(e.target.value)}
              />
            </Field>
            <Field label="Org role">
              <select
                value={memberRole}
                onChange={(e) => setMemberRole(e.target.value as OrgRole)}
              >
                {ORG_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </Field>
            <button
              disabled={memberLogin.trim() === ''}
              onClick={() =>
                void act(async () => {
                  await api.putOrgMember(slug, {
                    user_login: memberLogin.trim(),
                    role: memberRole,
                  });
                  setMemberLogin('');
                }, 'member saved')
              }
            >
              Add / update member
            </button>
          </div>
        )}
      </div>

      <div className="panel">
        <h2>Teams</h2>
        {teams.length === 0 ? (
          <Empty>No teams yet.</Empty>
        ) : (
          <div className="row">
            {teams.map((t) => (
              <button
                key={t.id}
                className={selected === t.slug ? 'primary' : ''}
                onClick={() => setSelected(selected === t.slug ? '' : t.slug)}
              >
                {t.parent ? `${t.parent} / ${t.slug}` : t.slug}
              </button>
            ))}
          </div>
        )}
        {selected !== '' && (
          <TeamPanel
            key={selected}
            org={slug}
            team={selected}
            repos={repos}
            canManage={canManage}
          />
        )}
        {canManage && (
          <div className="row" style={{ alignItems: 'flex-end', marginTop: 10 }}>
            <Field label="Team slug">
              <input
                type="text"
                value={teamSlug}
                onChange={(e) => setTeamSlug(e.target.value)}
              />
            </Field>
            <Field label="Parent team">
              <select value={teamParent} onChange={(e) => setTeamParent(e.target.value)}>
                <option value="">none</option>
                {teams.map((t) => (
                  <option key={t.id} value={t.slug}>
                    {t.slug}
                  </option>
                ))}
              </select>
            </Field>
            <button
              disabled={teamSlug.trim() === ''}
              onClick={() =>
                void act(async () => {
                  await api.createTeam(slug, {
                    slug: teamSlug.trim(),
                    ...(teamParent === '' ? {} : { parent: teamParent }),
                  });
                  setTeamSlug('');
                }, 'team created')
              }
            >
              Create team
            </button>
          </div>
        )}
      </div>

      <div className="panel">
        <h2>Repositories</h2>
        {repos.length === 0 ? (
          <Empty>
            No repositories you can read. Create one named <code>{org.slug}/name</code>.
          </Empty>
        ) : (
          <ul>
            {repos.map((r) => (
              <li key={r.id}>
                <Link to={`/r/${r.slug}`}>{r.slug}</Link> <Chip>{r.visibility}</Chip>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export function OrgSettingsView(): ReactElement {
  const { org } = useParams();
  return org === undefined ? <OrgIndex /> : <OrgDetail key={org} slug={org} />;
}
