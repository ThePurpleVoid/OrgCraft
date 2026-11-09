// Shared steps for the Studio's Team page in the e2e suites (L10): the catalog adds teammates, a teammate is switched
// on and off from its card's inspector, a team's own role opens from "Edit the job description", and Meetings sits
// in the More menu. `scope` is the page, or the Studio's root element when it is mounted in a host page.

/** The catalog row for a role, by its title. */
export const catalogRow = (scope, title) => scope.locator('#library .cat-role', { hasText: title }).first();

/** The slug of the role a catalog row shows. */
export const slugOf = async (scope, title) => catalogRow(scope, title).getAttribute('data-type');

/** Whether teammate `slug` is on the team (its card is on the chart and not dimmed). */
export async function isOn(scope, slug) {
  const card = scope.locator(`#canvas [data-node="${slug}"]`);
  if (!(await card.count())) return false;
  return !/\boff\b/.test((await card.first().getAttribute('class')) ?? '');
}

/** Opens teammate `slug` in the inspector, from its card. */
export async function selectTeammate(scope, slug) {
  await scope.locator(`#canvas [data-node="${slug}"]`).first().click();
  await scope.locator('#i-name').waitFor();
}

/**
 * Switches teammate `slug` on or off from its inspector. A role with no seat on the chart is switched on by adding it
 * from the catalog (its own seat is used when free).
 */
export async function switchTeammate(scope, slug, on) {
  const card = scope.locator(`#canvas [data-node="${slug}"]`);
  if (!(await card.count())) {
    if (!on) return;
    const row = scope.locator(`#library .cat-role[data-type="${slug}"]`).first();
    if (!(await row.isVisible())) await scope.locator('#library details.browse > summary').click();
    await row.click();
    return;
  }
  await selectTeammate(scope, slug);
  if ((await isOn(scope, slug)) !== on) await scope.locator('#i-enabled').click();
}

/** Opens the editor of one of the team's own roles, by its title, through "Edit the job description". */
export async function openJob(scope, title) {
  const slug = await slugOf(scope, title);
  await selectTeammate(scope, slug);
  await scope.getByRole('button', { name: 'Edit the job description' }).click();
  const go = scope.locator('#i-editjob-go');
  if (await go.isVisible()) await go.click();
}

/** Opens a page that lives in the More menu (Meetings). */
export async function openFromMore(scope, name) {
  await scope.locator('#more-btn').click();
  await scope.locator('#more-menu').getByRole('button', { name, exact: true }).click();
}
