const fs = require('fs');

const html = fs.readFileSync('instagram-accounts.html', 'utf8');

const checks = [
  ['Theme Sync in Head', html.includes("localStorage.getItem('comment2dm_theme')")],
  ['Theme Toggle Button', html.includes('id="themeToggleBtn"')],
  ['Connect Account Button', html.includes('id="connectAccountBtn"')],
  ['Accounts List Container', html.includes('id="accountsListContainer"')],
  ['Accounts Empty State', html.includes('id="accountsEmptyState"')],
  ['Disconnect Modal', html.includes('id="disconnectModal"')],
  ['Cancel Disconnect Btn', html.includes('id="cancelDisconnectBtn"')],
  ['Confirm Disconnect Btn', html.includes('id="confirmDisconnectBtn"')],
  ['Meta Security Card', html.includes('class="meta-security-card"')],
  ['No mojibake / corrupted bytes', !html.includes('\uFFFD') && !html.includes('ðŸ')],
  ['SVG Icons Present', html.includes('<svg') && html.includes('viewBox="0 0 24 24"')],
  ['Meta API Authorization link', html.includes('/api/instagram/authorize')],
  ['DELETE Account API call', html.includes('/api/instagram/accounts/')],
  ['Automations API fetch', html.includes('/api/automations')]
];

let allPassed = true;
checks.forEach(([name, passed]) => {
  console.log((passed ? '✓' : '✗') + ' ' + name);
  if (!passed) allPassed = false;
});

// Also check styles.css for the classes
const css = fs.readFileSync('styles.css', 'utf8');
const cssChecks = [
  ['CSS: .status-pill', css.includes('.status-pill')],
  ['CSS: .status-connected', css.includes('.status-connected')],
  ['CSS: .status-expired', css.includes('.status-expired')],
  ['CSS: .ig-account-card', css.includes('.ig-account-card')],
  ['CSS: .ig-avatar-ring', css.includes('.ig-avatar-ring')],
  ['CSS: .meta-security-card', css.includes('.meta-security-card')],
  ['CSS: .modal-icon-badge.danger', css.includes('.modal-icon-badge.danger')]
];

console.log('\n--- CSS CHECKS ---');
cssChecks.forEach(([name, passed]) => {
  console.log((passed ? '✓' : '✗') + ' ' + name);
  if (!passed) allPassed = false;
});

if (!allPassed) {
  console.error('\nVerification failed!');
  process.exit(1);
}

console.log('\n✅ All Instagram accounts page & style checks PASSED!');
