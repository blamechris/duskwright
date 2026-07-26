import {getUILanguage} from './locales';
import {isEdge, isMobile} from './platform';

// Duskwright owns every endpoint the extension can reach. Nothing here may point at
// darkreader.org: that would send our users to upstream's site, solicit donations on
// upstream's behalf, and — for the fetched endpoints — phone a third party we do not
// control, contradicting the zero-telemetry posture the README and store listing promise.
//
// Several upstream features behind these links (news, donations, mobile, uninstall survey)
// do not exist in Duskwright. The URLs are neutralised so nothing is fetched from or sent
// to upstream; removing the UI surfaces themselves is tracked separately for E8.
export const HOMEPAGE_URL = 'https://github.com/blamechris/duskwright';
export const BLOG_URL = 'https://github.com/blamechris/duskwright/releases/';
// Empty disables the news fetch. Upstream polled darkreader.org for a news feed — a
// scheduled outbound request, which we do not make.
export const NEWS_URL = '';
export const DEVTOOLS_DOCS_URL = 'https://github.com/blamechris/duskwright/blob/main/CLAUDE.md';
// Duskwright takes no donations. Points at the repo rather than upstream's donate page.
export const DONATE_URL = 'https://github.com/blamechris/duskwright';
export const GITHUB_URL = 'https://github.com/blamechris/duskwright';
export const MOBILE_URL = 'https://github.com/blamechris/duskwright';
export const PRIVACY_URL = 'https://github.com/blamechris/duskwright/blob/main/PRIVACY.md';
export const TWITTER_URL = 'https://github.com/blamechris/duskwright';
// Empty means no uninstall URL is registered, so uninstalling makes no request.
export const UNINSTALL_URL = '';
export const HELP_URL = 'https://github.com/blamechris/duskwright/blob/main/README.md';
// The per-site fixes catalog is served from our own repo. E9's scheduled sync pulls
// upstream's catalog into ours via PR, so coverage still flows from upstream — but the
// extension only ever fetches from a repo we control and have reviewed.
export const CONFIG_URL_BASE = 'https://raw.githubusercontent.com/blamechris/duskwright/main/src/config';

const helpLocales = [
    'be',
    'cs',
    'de',
    'en',
    'es',
    'fr',
    'it',
    'ja',
    'nl',
    'pt',
    'ru',
    'sr',
    'tr',
    'zh-CN',
    'zh-TW',
];

export function getHelpURL(): string {
    if (isEdge && isMobile) {
        return HELP_URL;
    }
    const locale = getUILanguage();
    // Duskwright has no localised help pages yet, so every locale resolves to the README.
    // helpLocales is retained so restoring per-locale help is a one-line change.
    void (helpLocales.find((hl) => hl === locale) || helpLocales.find((hl) => locale.startsWith(hl)) || 'en');
    return HELP_URL;
}

export function getBlogPostURL(postId: string): string {
    return `${BLOG_URL}${postId}/`;
}
