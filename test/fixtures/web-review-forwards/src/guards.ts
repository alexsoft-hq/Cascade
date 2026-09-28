import axios from 'axios';
// Hops whose hand-on this lane reads (a member, a spread) and hops it cannot
// (a local, a rest): the URL still reaches the sink in each.
const byMember = (options: any) => fetch(options.url, options);
const byLocal = (option: any) => { const copy = { ...option }; return axios(copy); };
const byRest = (option: any) => { const { headers, ...rest } = option; return axios({ ...rest, headers }); };
const passOn = (o: any) => axios({ ...o });
export const client = {
  member: (option: any) => { const response = byMember(option); return response; },
  local: (option: any) => { const response = byLocal(option); return response; },
  rest: (option: any) => { const response = byRest(option); return response; },
  // The wrapper writes GET BEFORE the caller's options: a default the caller's
  // own `method` replaces, and the hop below writes none.
  post: (option: any) => { const response = passOn({ method: 'GET', ...option }); return response; },
};
