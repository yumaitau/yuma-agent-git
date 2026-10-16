import { expect, test, type Browser, type BrowserContext } from '@playwright/test';

/**
 * The golden path (issue #80): file an issue, open a pull request that closes
 * it, comment inline and approve as a second person, merge, and see the issue
 * closed. Every write goes through the public API or the dashboard.
 */

const slug = `ada/golden-${Date.now().toString(36)}`;
const b64 = (text: string): string => Buffer.from(text).toString('base64');

async function signedIn(browser: Browser, session: string): Promise<BrowserContext> {
  const baseURL = test.info().project.use.baseURL!;
  const context = await browser.newContext({ baseURL });
  const { hostname } = new URL(baseURL);
  await context.addCookies([
    { name: 'yag_session', value: session, domain: hostname, path: '/' },
  ]);
  return context;
}

test('issue to merged pull request', async ({ browser }) => {
  const ada = await signedIn(browser, process.env.YAG_E2E_ADA!);
  const grace = await signedIn(browser, process.env.YAG_E2E_GRACE!);
  const author = { name: 'Ada', email: 'ada@example.com' };

  // a repository with one commit on main and a proposed change on top
  const api = ada.request;
  expect((await api.post('/api/v1/repos', { data: { slug } })).status()).toBe(201);
  const commit = async (parent: string | null, message: string, text: string) => {
    const res = await api.post(`/api/v1/repos/${slug}/changesets`, {
      data: {
        first_parent: parent,
        message,
        author,
        changes: [
          { path: 'greet.txt', op: parent ? 'mod' : 'add', content_b64: b64(text) },
        ],
      },
    });
    expect(res.status(), await res.text()).toBe(201);
    return ((await res.json()) as { changeset: { id: string } }).changeset.id;
  };
  const base = await commit(null, 'Add greeting', 'one\nhello\nthree\n');
  const moved = await api.put(`/api/v1/repos/${slug}/refs/main`, {
    data: { from: null, to: base },
  });
  expect(moved.ok(), await moved.text()).toBe(true);
  const head = await commit(base, 'Say good day', 'one\ngood day\nthree\n');
  const member = await api.put(`/api/v1/repos/${slug}/members`, {
    data: { user_login: 'grace', role: 'write' },
  });
  expect(member.ok(), await member.text()).toBe(true);

  // Ada files an issue
  const page = await ada.newPage();
  await page.goto(`/r/${slug}/issues/new`);
  await page.getByLabel('Title').fill('Greeting is too casual');
  await page.getByRole('button', { name: 'Open issue' }).click();
  await expect(page).toHaveURL(new RegExp(`/r/${slug}/issues/1$`));
  await expect(page.getByText('Open', { exact: true })).toBeVisible();

  // Ada opens a pull request that closes it
  await page.goto(`/r/${slug}/pulls`);
  await page.getByRole('button', { name: 'New pull request' }).click();
  await page.getByLabel('Title').fill('Use a formal greeting');
  await page.getByLabel('Proposed changeset ID').fill(head);
  await page.getByLabel('What changed and why?').fill('Closes #1');
  await page.getByRole('button', { name: 'Create pull request' }).click();
  await expect(page).toHaveURL(new RegExp(`/r/${slug}/pulls/\\d+$`));
  const pullUrl = new URL(page.url()).pathname;

  // Grace comments on the changed line, then approves
  const review = await grace.newPage();
  await review.goto(pullUrl);
  await review.getByRole('button', { name: 'Comment on line 2' }).click();
  const box = review.getByRole('textbox', { name: 'Comment on line 2' });
  await expect(box).toBeFocused();
  await box.fill('Should this say good morning?');
  await review.getByRole('button', { name: 'Add comment' }).click();
  await expect(review.getByText('Should this say good morning?').first()).toBeVisible();
  await review.getByLabel('Review comment').fill('Looks good');
  await review.getByRole('button', { name: 'Approve' }).click();
  await expect(review.getByText('Looks good').first()).toBeVisible();

  // Ada sees the thread, merges, and the issue closes
  await page.reload();
  await expect(page.getByText('Should this say good morning?').first()).toBeVisible();
  const merge = page.getByRole('button', { name: 'Create a merge commit' });
  await expect(merge).toBeEnabled();
  await merge.click();
  await expect(page.getByText(/^merged/)).toBeVisible();
  await page.goto(`/r/${slug}/issues/1`);
  await expect(page.getByText(/^Closed/)).toBeVisible();

  await ada.close();
  await grace.close();
});
