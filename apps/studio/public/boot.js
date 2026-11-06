// The local Studio (agent-team studio): the same Studio a host mounts, on the whole page, with the page in the URL's
// hash. Its server holds the launch token's session cookie, so no headers are needed.
import { mount } from './app.js';

mount(document.body, { urlState: true });
