export function instrumentFailure(status: number | undefined, resource: string) {
  if (status === 400) return { title: `${resource} request was not accepted`, message: "Check the search or selected version and try again." };
  if (status === 401) return { title: "Sign-in required", message: "Your session needs to be refreshed before this member data can be shown." };
  if (status === 403) return { title: `${resource} is restricted`, message: "The supplier or account permissions do not allow this audience to view the requested data." };
  if (status === 404) return { title: `${resource} was not found`, message: "No matching catalog record is available." };
  if (status === 503) return { title: `${resource} provider unavailable`, message: "The reference provider is temporarily unavailable. Retry when service resumes." };
  return { title: `${resource} unavailable`, message: status ? `The service returned HTTP ${status}. Refresh to retry; no sample data is substituted.` : "The service did not respond. Refresh to retry; no sample data is substituted." };
}
