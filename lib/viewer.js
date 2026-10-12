// View-only admin accounts (users.admin_viewer = true), e.g. for DirtBidder's lawyer.
// A viewer can open every admin screen, but:
//   - every change (anything that isn't a GET request) is refused by the server, on every route, and
//   - every admin screen shows only test data: test accounts (+test / +op emails) and their jobs, bids,
//     messages, disputes and flags. Real customers' details are never shown to a viewer.
const VIEW_ONLY_MSG = 'This is a view-only account, so it can look around but can’t change anything.';

// SQL: is this user row (by alias) a test account?
const TEST = a => `(${a}.email ~* '\\+(test|op)[0-9]*@')`;
const TEST_RE = /\+(test|op)\d*@/i;
const isTestEmail = e => TEST_RE.test(String(e || ''));

module.exports = { VIEW_ONLY_MSG, TEST, TEST_RE, isTestEmail };
