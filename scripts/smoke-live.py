#!/usr/bin/env python3
"""Exercise a deployed Worker using disposable, short-lived smoke identities.

Run through cf-vault. Only identity/session fixtures are seeded through D1;
repository operations use the public API and built CLI. This does not test OAuth.
Raw credentials stay in memory and are never written to the report or CLI config.
"""
import argparse
import base64
import hashlib
import io
import json
import os
from pathlib import Path
import secrets
import subprocess
import tempfile
import tarfile
import time
import traceback
import urllib.error
import urllib.request
import uuid


parser = argparse.ArgumentParser()
parser.add_argument('--url', required=True)
parser.add_argument('--database-id', required=True)
parser.add_argument('--report', required=True)
parser.add_argument('--ci', action='store_true')
parser.add_argument('--slug', help='Unique fixture slug; required for an operator-authorized publish destination')
parser.add_argument('--publish-image', help='Optional exact image destination already authorized on the Worker')
args = parser.parse_args()
if args.publish_image and (not args.ci or not args.slug):
    parser.error('--publish-image requires --ci and --slug')
origin = args.url.rstrip('/')
assert origin.startswith('https://'), 'HTTPS required'
account = os.environ['CLOUDFLARE_ACCOUNT_ID']
cf_token = os.environ['CLOUDFLARE_API_TOKEN']
project = Path(__file__).resolve().parent.parent
report = {'url': origin, 'started_at': int(time.time()), 'checks': [], 'runs': [],
          'oauth_tested': False, 'registry_push_tested': False}
identities = []
repo_path = None


def sql(statement, params=()):
    request = urllib.request.Request(
        f'https://api.cloudflare.com/client/v4/accounts/{account}/d1/database/{args.database_id}/query',
        data=json.dumps({'sql': statement, 'params': list(params)}).encode(),
        headers={'Authorization': f'Bearer {cf_token}', 'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            data = json.load(response)
    except urllib.error.HTTPError as error:
        raise RuntimeError(f'Cloudflare D1 returned HTTP {error.code}') from None
    if not data.get('success'):
        raise RuntimeError('Cloudflare D1 query failed')
    return data['result'][0].get('results', [])


def request(path, method='GET', body=None, credential=None, expected=200, raw=False):
    headers = {'Content-Type': 'application/json', 'User-Agent': 'yuma-agent-git-smoke/1.0'}
    if credential:
        headers[credential[0]] = credential[1]
    req = urllib.request.Request(origin + path, method=method, headers=headers,
                                 data=None if body is None else json.dumps(body).encode())
    try:
        response = urllib.request.urlopen(req, timeout=120)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        content = response.read()
        status = response.status
    if status != expected:
        # Never include request headers, cookies, token responses, or Cloudflare auth.
        code = ''
        try:
            code = json.loads(content).get('error', {}).get('code', '')
        except (ValueError, AttributeError):
            pass
        raise AssertionError(f'{method} {path}: expected {expected}, got {status} ({code})')
    return content if raw else json.loads(content)


def passed(name):
    report['checks'].append(name)
    print('PASS', name, flush=True)


def identity(label):
    identifier = 'smoke-' + uuid.uuid4().hex
    cookie = secrets.token_hex(32)
    now = int(time.time() * 1000)
    sql('INSERT INTO users (id,github_id,login,created_at) VALUES (?,?,?,?)',
        [identifier, -secrets.randbelow(2**48) - 1, identifier, now])
    identities.append(identifier)
    sql('INSERT INTO sessions (token_hash,user_id,created_at,expires_at) VALUES (?,?,?,?)',
        [hashlib.sha256(cookie.encode()).hexdigest(), identifier, now, now + 3600000])
    return identifier, ('Cookie', 'yag_session=' + cookie)


def cli(arguments, directory, token):
    child_env = {k: v for k, v in os.environ.items()
                 if k not in ('CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'AGENT_VAULT_TOKEN')}
    child_env['YAG_TOKEN'] = token
    result = subprocess.run(['node', str(project / 'cli/dist/index.js'), *arguments],
                            cwd=directory, env=child_env, capture_output=True, timeout=120)
    if result.returncode:
        detail = result.stderr.decode(errors='replace').replace(token, '[redacted]')[:1000]
        raise AssertionError('CLI command failed: ' + arguments[0] + ': ' + detail)
    return result.stdout.decode()


def wait_run(identifier, expected=None, running=False, limit=240):
    end = time.monotonic() + limit
    previous = None
    while time.monotonic() < end:
        overview = request(repo_path + '/ci', credential=owner)
        job = next(item for item in overview['runs'] if item['id'] == identifier)
        if job['state'] != previous:
            print('RUN', identifier, job['state'], flush=True)
            previous = job['state']
        if running and job['state'] == 'running':
            return job
        if job['state'] not in ('queued', 'running'):
            report['runs'].append({k: job[k] for k in ('id', 'state', 'started_at', 'finished_at', 'error')})
            if expected is not None and job['state'] != expected:
                report['last_run_log'] = request(repo_path + f'/ci/runs/{identifier}/log', credential=owner, raw=True).decode()[-6000:]
                raise AssertionError(f'Run {identifier}: expected {expected}, got {job["state"]}')
            return job
        time.sleep(3)
    raise AssertionError('Runner did not settle within the smoke-test timeout')


try:
    assert request('/healthz')['ok']
    assert b'<html' in request('/', raw=True).lower()
    passed('public health and dashboard assets')
    owner_id, owner = identity('owner')
    reviewer_id, reviewer = identity('reviewer')
    suffix = uuid.uuid4().hex[:12]
    slug = args.slug or 'smoke/deploy-' + suffix
    repo = request('/api/v1/repos', 'POST', {'slug': slug}, owner, 201)['repo']
    repo_path = '/api/v1/repos/' + slug
    report['repository'] = slug
    request(repo_path + '/members', 'PUT', {'user_id': reviewer_id, 'role': 'write'}, owner)
    other = request('/api/v1/repos', 'POST', {'slug': 'smoke/other-' + suffix}, owner, 201)['repo']
    limited = request('/api/v1/tokens', 'POST', {'label': 'live smoke readonly', 'repo_id': repo['id'],
                       'scopes': ['repo:read'], 'expires_at': int(time.time() * 1000) + 3600000}, owner, 201)['token']
    readonly = ('Authorization', 'Bearer ' + limited)
    request('/api/v1/tokens', 'POST', {'label': 'must-not-escalate'}, readonly, 401)
    request(repo_path + '/changesets', 'POST', {}, readonly, 403)
    request('/api/v1/repos/' + other['slug'] + '/changesets', credential=readonly, expected=404)
    assert [r['id'] for r in request('/api/v1/repos', credential=readonly)['repos']] == [repo['id']]
    for anonymous_path in (repo_path + '/changesets', repo_path, '/api/v1/repos', '/api/v1'):
        request(anonymous_path, expected=401)
    passed('live read-only scope, repository isolation, sign-in requirement, and token escalation denial')
    files = {'hello.txt': 'hello from the live smoke test\n',
             'package.json': json.dumps({'name': 'yag-live-smoke', 'private': True,
                 'scripts': {'lint': 'node --check build.js', 'build': 'node build.js'}}),
             'build.js': 'console.log("YAG_SMOKE_BUILD_OK");\n',
             'Dockerfile': 'FROM scratch\nCOPY hello.txt /hello.txt\n'}
    root = request(repo_path + '/changesets', 'POST', {'first_parent': None,
        'message': 'Live deployment smoke fixture', 'author': {'name': 'Smoke', 'email': 'smoke@example.invalid'},
        'changes': [{'path': path, 'op': 'add', 'content_b64': base64.b64encode(value.encode()).decode()}
                    for path, value in files.items()]}, owner, 201)['changeset']['id']
    request(repo_path + '/refs/main', 'PUT', {'from': None, 'to': root}, owner)
    raw = request(repo_path + f'/file?cs={root}&path=hello.txt&format=raw', credential=owner, raw=True)
    assert raw == files['hello.txt'].encode()
    tar = request(repo_path + f'/export/tarball?cs={root}', credential=owner, raw=True)
    with tarfile.open(fileobj=io.BytesIO(tar), mode='r:gz') as archive:
        assert archive.extractfile('hello.txt').read() == files['hello.txt'].encode(), 'Tar export content mismatch'
    passed('commit, ref creation, source retrieval, and tar export')
    write_token = request('/api/v1/tokens', 'POST', {'label': 'live smoke CLI', 'repo_id': repo['id'],
                          'scopes': ['repo:read', 'repo:write'], 'expires_at': int(time.time() * 1000) + 3600000}, owner, 201)['token']
    policy = {'commands': ['npm run lint', 'npm run build', 'docker build --network=host -t yag-smoke .'],
              'timeout_seconds': 120, 'required_approvals': 1, 'require_checks': args.ci,
              'protect_default': True, 'image': args.publish_image}
    request(repo_path + '/ci', 'PUT', policy, owner)
    with tempfile.TemporaryDirectory(prefix='yag-live-smoke-') as temporary:
        directory = Path(temporary) / 'checkout'
        cli(['clone', slug, str(directory), '--api', origin], temporary, write_token)
        assert (directory / 'hello.txt').read_text() == files['hello.txt']
        (directory / 'hello.txt').write_text('updated in a real CLI checkout\n')
        cli(['commit', '-m', 'Smoke CLI edit'], directory, write_token)
        head = json.loads((directory / '.yag/state.json').read_text())['cs']
        cli(['pr', '--title', 'Live smoke pull request', '--draft'], directory, write_token)
        assert 'token' not in json.loads((directory / '.yag/config.json').read_text())
        cli(['ci', 'status'], directory, write_token)
    passed('real CLI clone, edit, commit, draft PR, and status')
    pull = request(repo_path + '/pulls', credential=owner)['pulls'][0]
    pp = repo_path + f'/pulls/{pull["id"]}'
    review = {'head_cs': head, 'revision': 1, 'decision': 'approve', 'body': 'Live smoke review'}
    request(pp + '/merge', 'POST', {'head_cs': head, 'revision': 1}, owner, 409)
    request(pp + '/review', 'POST', review, owner, 403)
    request(repo_path + '/refs/main', 'PUT', {'from': root, 'to': head, 'force': True}, owner, 403)
    request(pp + '/review', 'POST', review, reviewer)
    request(pp + '/update', 'POST', {'state': 'open'}, owner)
    if args.ci:
        request(pp + '/merge', 'POST', {'head_cs': head, 'revision': 1}, owner, 409)
        overview = request(repo_path + '/ci', credential=owner)
        assert overview['enabled'], 'CI execution disabled'
        existing = [r for r in overview['runs'] if r['head_cs'] == head]
        job = existing[0] if existing else request(repo_path + '/ci/runs', 'POST', {'head': head}, owner, 202)['run']
        if job['state'] in ('queued', 'running'):
            request(repo_path + '/ci/runs', 'POST', {'head': head}, owner, 429)
        wait_run(job['id'], 'passed')
        log = request(repo_path + f'/ci/runs/{job["id"]}/log', credential=owner, raw=True)
        assert b'YAG_SMOKE_BUILD_OK' in log
        passed('real Cloudflare lint/build/Docker build, logs, duplicate admission, and CI merge gate')
    request(pp + '/merge', 'POST', {'head_cs': head, 'revision': 1}, owner)
    assert request(repo_path + '/refs/main', credential=owner)['head'] == head
    history = request(repo_path + '/changesets?limit=1', credential=owner)
    assert history['changesets'][0]['id'] == head and history['next_cursor'] == root
    passed('draft/self-approval/protected-ref rejection and reviewed merge with history')
    if args.ci:
        if args.publish_image:
            job = request(repo_path + '/ci/runs', 'POST', {'head': head, 'publish': True}, owner, 202)['run']
            published = wait_run(job['id'], 'passed')
            assert published['image'] == f'{args.publish_image}:cs-{head}', 'Published image tag mismatch'
            report['registry_push_tested'] = True
            report['published_image'] = published['image']
            passed('real Docker export, isolated publisher, and registry push')
        cases = [] if args.publish_image else [
            ('command failure', ['echo intentional-smoke-failure; exit 7'], 'failed', 60),
            ('deadline', ['sleep 60'], 'timed_out', 30),
            ('cancellation', ['sleep 120'], 'cancelled', 120),
        ]
        for label, commands, expected, timeout in cases:
            request(repo_path + '/ci', 'PUT', {**policy, 'commands': commands, 'timeout_seconds': timeout}, owner)
            job = request(repo_path + '/ci/runs', 'POST', {'head': head}, owner, 202)['run']
            if expected == 'cancelled':
                wait_run(job['id'], running=True)
                time.sleep(15)
                request(repo_path + f'/ci/runs/{job["id"]}/cancel', 'POST', {}, owner)
            wait_run(job['id'], expected)
            passed('real runner ' + label)
    else:
        request(repo_path + '/ci/runs', 'POST', {'head': head}, owner, 503)
        passed('execution disabled until pilot enablement')
    report['success'] = True
except Exception as error:
    report['success'] = False
    location = traceback.extract_tb(error.__traceback__)[-1]
    report['failure'] = str(error) or f'{type(error).__name__} at line {location.lineno}'
    print('FAIL', report['failure'], flush=True)
finally:
    cleanup_errors = []
    if repo_path:
        try:
            overview = request(repo_path + '/ci', credential=owner)
            for job in overview['runs']:
                if job['state'] in ('queued', 'running'):
                    request(repo_path + f'/ci/runs/{job["id"]}/cancel', 'POST', {}, owner)
        except Exception:
            report['runner_cleanup_failed'] = True
    for identifier in identities:
        try:
            sql('DELETE FROM sessions WHERE user_id = ?', [identifier])
            sql('DELETE FROM api_tokens WHERE user_id = ?', [identifier])
        except Exception:
            cleanup_errors.append(identifier)
    report['credentials_revoked'] = not cleanup_errors
    report['finished_at'] = int(time.time())
    Path(args.report).write_text(json.dumps(report, indent=2) + '\n')
    print('Report:', args.report, flush=True)
    if cleanup_errors:
        print('Credential cleanup needs retry for smoke identities:', ', '.join(cleanup_errors), flush=True)

raise SystemExit(0 if report.get('success') and report['credentials_revoked'] and not report.get('runner_cleanup_failed') else 1)
