import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter, Navigate, Outlet, RouterProvider, useLocation } from 'react-router-dom'
// The /react entry point, not /next: this is a Vite SPA, and the Next.js build of this
// package imports next/navigation, which does not resolve here. Route changes are picked
// up from the History API, so one mount at the root covers every page.
import { Analytics } from '@vercel/analytics/react'
import App from './App'
import DashboardPage from './pages/DashboardPage'
import NotebookPage from './pages/NotebookPage'
import NotePage from './features/editor/NotePage'
import StudyPage from './features/study/StudyPage'
import AskPage from './features/ask/AskPage'
import CaptureRoute from './features/import/CaptureRoute'
import SearchPage from './pages/SearchPage'
import TagsPage from './pages/TagsPage'
import { AuthProvider, useAuth } from './features/auth/AuthContext'
import RequireAuth from './features/auth/RequireAuth'
import LandingPage from './features/marketing/LandingPage'
import SitemapPage from './features/marketing/SitemapPage'
import DownloadPage from './features/download/DownloadPage'
import LoginPage from './features/auth/LoginPage'
import SignupPage from './features/auth/SignupPage'
import RecoverPage from './features/auth/RecoverPage'
import JoinPage from './features/share/JoinPage'
import TryRoute from './features/guest/TryRoute'
import GuestMigrationHost from './features/guest/GuestMigrationHost'
import { useGuest } from './features/guest/guestMode'
import { registerServiceWorker } from './registerSW'
import './styles/index.css'

// AuthProvider sits inside the router (rather than around RouterProvider) so the auth
// pages can use useNavigate/useLocation, and so one /me call serves every route.
//
// GuestMigrationHost is a sibling of the routes rather than a page: the moment a guest
// signs in can happen on /login, /signup or a redirect back from an OAuth provider, and
// the offer to carry their notes across has to survive all three.
function AuthRoot() {
  return (
    <AuthProvider>
      <Outlet />
      <GuestMigrationHost />
    </AuthProvider>
  )
}

// "/" serves two different products depending on who is asking: the marketing page to a
// visitor, the dashboard to a signed-in user.
//
// The pathname check matters. Only the index is public - a signed-out visitor deep-linking
// to /study or /note/x must still fall through to RequireAuth, which sends them to /login
// and remembers where they were headed. Without it they would land on the marketing page
// with their destination silently discarded.
//
// No loading branch is needed: AuthProvider withholds render entirely until the first /me
// settles, so `user` is already decided by the time this runs.
function RootRoute() {
  const { user, scope } = useAuth()
  const guest = useGuest()
  const { pathname } = useLocation()
  // A guest already chose the product over the pitch, so "/" is their dashboard. Sending
  // them back to the marketing page would look like being signed out of the notes they
  // are part way through writing.
  //
  // Inside the Electron shell the pitch is already spent. desktop/main.ts loads this same
  // production origin, so without the check below the desktop app opens onto the marketing
  // hero - "Start writing, it's free" shown to somebody who has already installed the thing.
  // The signed-out desktop root is the login screen instead. It keeps the guest link, so a
  // first run with no account is still not a dead end.
  //
  // `unoteDesktop` is exposed by desktop/preload.ts over contextBridge and is simply absent
  // in a browser, so the web landing page is untouched by this.
  if (!user && !guest && pathname === '/') {
    return window.unoteDesktop?.isDesktop ? <LoginPage /> : <LandingPage />
  }
  // A QR-paired phone is signed in as the user but authorised for capture only, so the
  // desktop shell would render and then 403 on every fetch it makes. Send it where its
  // session actually works. The server enforces the same boundary independently.
  if (user && scope === 'capture') return <Navigate to="/capture" replace />
  return (
    <RequireAuth>
      <App />
    </RequireAuth>
  )
}

const router = createBrowserRouter([
  {
    element: <AuthRoot />,
    children: [
      // Public, and deliberately outside <App> - a signed-out visitor must not see
      // the sidebar or trigger the shell's authenticated data fetches.
      { path: '/login', element: <LoginPage /> },
      { path: '/signup', element: <SignupPage /> },
      { path: '/recover', element: <RecoverPage /> },

      // Public, and public on purpose even for a signed-in visitor: it is a map of the
      // product rather than a signed-out pitch, and a link to it sits in the footer of
      // every marketing page. It stays outside <App> for the same reason the landing page
      // does - no sidebar, and none of the shell's authenticated fetches.
      //
      // Unlike /download it has no second HTML entry, so a crawler that runs no JavaScript
      // gets index.html's head rather than this page's. That is a deliberate difference in
      // kind, not an oversight: /download exists to be FOUND by those crawlers, while this
      // page exists to answer "what is in this app?" for a person who is already here.
      { path: '/sitemap', element: <SitemapPage /> },

      // The desktop download page. Public, and the one route with a SECOND HTML entry
      // behind it (web/download.html) - the SPA's catch-all rewrite would otherwise hand
      // crawlers the homepage's head for a page that is not the homepage, and the bots
      // this site is written for run no JavaScript. This route is only what renders on
      // top of that document once the bundle loads.
      //
      // Inside AuthRoot like every other public page, which costs one /me round trip
      // before first paint. It uses no auth context and could be hoisted to a top-level
      // entry to paint sooner; it is here because "/" already pays the same cost and two
      // marketing pages behaving differently is the more expensive kind of surprise.
      { path: '/download', element: <DownloadPage /> },

      // The one-click way in without an account. Public by necessity, and it does its
      // work (start the session, seed a first note) before redirecting into the shell.
      { path: '/try', element: <TryRoute /> },

      // Share links. PUBLIC and outside RequireAuth by design - a guest opening
      // one has no Unote account at all; their access is a per-share cookie the
      // join call sets. It stays inside AuthRoot so the page can still recognise
      // the note's OWNER when they open their own link.
      { path: '/join/:token', element: <JoinPage /> },

      // Phone capture renders without the desktop shell, and is the one guarded page a
      // brand-new device is expected to open. It is deliberately NOT wrapped in
      // <RequireAuth> here: the QR carries a single-use pairing code that CaptureRoute
      // exchanges for a capture-scoped session first, then applies RequireAuth itself for
      // anyone arriving without one. Wrapping it here would send every scanning phone to
      // /login before the code was ever read.
      { path: '/capture', element: <CaptureRoute /> },
      {
        path: '/',
        element: <RootRoute />,
        children: [
          { index: true, element: <DashboardPage /> },
          { path: 'notebook/:notebookId', element: <NotebookPage /> },
          { path: 'note/:noteId', element: <NotePage /> },
          { path: 'study', element: <StudyPage /> },
          { path: 'ask', element: <AskPage /> },
          { path: 'search', element: <SearchPage /> },
          { path: 'tags', element: <TagsPage /> },
        ],
      },
    ],
  },
])

registerServiceWorker()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
    <Analytics />
  </StrictMode>,
)
