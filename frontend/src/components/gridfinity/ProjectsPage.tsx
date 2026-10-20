import type { Me } from '../../api'
import ProjectList from './ProjectList'

interface Props {
  me: Me
  onSignIn: () => void
}

/** Saved Gridfinity projects: in the account when signed in, otherwise in this browser. */
export default function ProjectsPage({ me, onSignIn }: Props) {
  const userId = me.user?.id ?? null
  return (
    <section className="page" aria-labelledby="projects-h">
      <div className="page-head">
        <h2 id="projects-h">My projects</h2>
        <p className="hint">
          {userId ? 'Saved to your account.' : 'Saved in this browser. '}
          {!userId && me.accounts && (
            <button type="button" className="link" onClick={onSignIn}>
              Sign in to keep them in your account
            </button>
          )}
        </p>
        <a className="button ghost" href="#/gridfinity">
          Back to Gridfinity
        </a>
      </div>
      <ProjectList userId={userId} onOpen={(p) => (window.location.hash = `#/gridfinity/${p.id}`)} />
    </section>
  )
}
