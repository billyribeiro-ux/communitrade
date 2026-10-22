export const PUBLIC_PROFILE_TABS = ['ideas', 'updates', 'reposts'] as const;
export type PublicProfileTab = typeof PUBLIC_PROFILE_TABS[number];

export function publicProfileTab(value: string | string[] | undefined): PublicProfileTab {
  const candidate = Array.isArray(value) ? value[0] : value;
  return PUBLIC_PROFILE_TABS.includes(candidate as PublicProfileTab) ? candidate as PublicProfileTab : 'ideas';
}

export function profileTabEmptyState(tab: PublicProfileTab): { heading: string; message: string } {
  switch (tab) {
    case 'ideas': return { heading: 'No visible public ideas', message: 'This profile has no currently visible publications.' };
    case 'updates': return { heading: 'No separate profile update posts', message: 'Phase 1 profiles show public ideas and reposts. Publication lifecycle changes remain on each original idea.' };
    case 'reposts': return { heading: 'No visible reposts', message: 'This member has not shared a currently visible community publication.' };
  }
}
