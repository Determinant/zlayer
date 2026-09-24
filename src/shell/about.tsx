import { useEffect, useRef } from 'react';
import { usePersistentState } from '../core/ui/use-persistent-state';
import { isBoolean } from '../core/storage/ui-state';
import { createPortal } from 'react-dom';

export function AboutLauncher() {
  const [open, setOpen] = usePersistentState('about-open', false, isBoolean);
  const dialog = useRef<HTMLDialogElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const release = document.querySelector('meta[name="zlayer-release"]')?.getAttribute('content');

  useEffect(() => {
    if (open) {
      dialog.current?.showModal();
      body.current?.scrollTo(0, 0);
    }
    else dialog.current?.close();
  }, [open]);

  return <>
    <button type="button" className="ui-button about-launcher" aria-label="About ZLayer"
      aria-haspopup="dialog" title="About ZLayer" onClick={() => setOpen(true)}>
      About ZLayer
    </button>

    {createPortal(<dialog ref={dialog} className="about-dialog" aria-labelledby="about-title"
      onCancel={event => { event.preventDefault(); event.stopPropagation(); setOpen(false); }}>
      <header className="about-heading">
        <div>
          <img src="/icon.svg" alt="" width="44" height="44" />
          <h2 id="about-title">About ZLayer</h2>
        </div>
        <button type="button" className="ui-button ui-button--icon" aria-label="Close about dialog" autoFocus
          onClick={() => setOpen(false)}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="1.8" strokeLinecap="round" aria-hidden="true" focusable="false">
            <path d="m6 6 12 12M18 6 6 18" />
          </svg>
        </button>
      </header>

      <div ref={body} className="about-body panel-scroll">
        <div className="about-intro">
          <p className="about-eyebrow">Free forever</p>
          <h3>A modern, lightweight EFB. <span>Layer by layer.</span></h3>
          <p>ZLayer is an electronic flight bag built around two ideas: your tools
            should travel with you, and every feature should have room to grow.</p>
        </div>

        <section className="about-principle" aria-labelledby="about-portability">
          <span className="about-number" aria-hidden="true">01</span>
          <div>
            <h3 id="about-portability">On your device. Online or offline.</h3>
            <p>ZLayer is a self-contained progressive web app (PWA). The complete EFB
              is delivered as static files, and its tools run directly on your device.
              Open it in a browser or install it on iOS or Android for the same
              portable experience.</p>
            <p>The app itself is saved locally for offline use. Download charts and
              data before you go, and keep using them without an internet connection.
              Connect again for fresh data and app updates.</p>
          </div>
        </section>

        <section className="about-principle" aria-labelledby="about-layers">
          <span className="about-number" aria-hidden="true">02</span>
          <div>
            <h3 id="about-layers">Everything starts with a layer.</h3>
            <p>Layers are more than things drawn on a map. Every major capability,
              from charts and weather to routes and plates, is built as a modular
              layer with its own data, behavior, and interface. Together, these
              layers form the EFB; individually, they give new ideas a place to grow.</p>
          </div>
        </section>

        <section className="about-data" aria-labelledby="about-data-title">
          <h3 id="about-data-title">Public data, openly available.</h3>
          <p>ZLayer will stay free forever. Its FAA charts, plates, and navigation
            data are compiled from FAA publications and are publicly available at{' '}
            <a href="https://charts.tedyin.com/" target="_blank" rel="noopener noreferrer">charts.tedyin.com</a>.
            Weather and terrain draw on other public data sources.</p>
        </section>

        <section className="about-community" aria-labelledby="about-community-title">
          <span className="about-status">Open source</span>
          <h3 id="about-community-title">Bring your next layer.</h3>
          <p>ZLayer is open source on{' '}
            <a href="https://github.com/Determinant/zlayer" target="_blank" rel="noopener noreferrer">GitHub</a>.
            {' '}Explore the code, report bugs, or build a layer of your own.</p>
          {release && /^[a-f0-9]{16}$/.test(release) && <p><a href={`/source/${release}.tar.gz`}>
            Download the source for this release
          </a>.</p>}
          <p>New layers, better ways to work with plates, or a tool no one has
            thought of yet: contributions from pilots and developers will help
            shape what comes next. There’s room for your ideas here, layer by layer.</p>
        </section>

        <section className="about-notice" aria-labelledby="about-notice-title">
          <h3 id="about-notice-title">A hobby project</h3>
          <p>ZLayer is a personal hobby project. The app and its data are provided
            “as is,” without warranty of any kind, express or implied.
            Please use it at your own risk.</p>
        </section>
      </div>

      <footer className="about-author">
        <div><span>Created by</span><strong>Ted Yin</strong></div>
        <a href="mailto:tederminant@gmail.com">tederminant@gmail.com</a>
      </footer>
    </dialog>, document.body)}
  </>;
}
