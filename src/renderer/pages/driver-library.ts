import { el, clear } from '../dom.ts';
import type { Page, PageContext } from '../router.ts';
import { api } from '../ipc.ts';
import { intelDriverKind, type IntelDriverKind, type IntelDriverRelease } from '../pure/intel-driver-updates.ts';
import { decodeDriverVersion } from '../pure/driver.ts';
import { showIntelDriverUpdateDialog } from '../components/intel-driver-update-dialog.ts';

type DriverLibraryApi = {
  intelDriverLibrary(kind: IntelDriverKind): Promise<{ versions: string[]; partial: boolean }>;
  intelDriverRelease(kind: IntelDriverKind, version: string): Promise<IntelDriverRelease>;
  intelDriverDownloadStatus(kind: IntelDriverKind, version: string): Promise<{ downloaded: boolean; sizeBytes: number | null }>;
};
const libraryApi = api as typeof api & DriverLibraryApi;

function sizeLabel(bytes: number | null | undefined): string {
  if (!Number.isFinite(bytes) || !bytes || bytes <= 0) return 'Size unavailable';
  return bytes >= 1024 ** 3 ? `${(bytes / (1024 ** 3)).toFixed(2)} GB` : `${(bytes / (1024 ** 2)).toFixed(0)} MB`;
}

function releaseDate(value: string | null): string {
  if (!value) return 'Date unavailable';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleDateString(undefined, { timeZone: 'UTC' });
}

export const driverLibraryPage: Page = {
  id: 'driver-library',
  render(container, ctx) {
    let kind: IntelDriverKind | null = null;
    let versions: string[] = [];
    let selected: IntelDriverRelease | null = null;
    let selectedVersion: string | null = null;
    let downloaded = false;
    let requestId = 0;
    let detailsLoading = false;
    let detailsError = false;
    const releaseCache = new Map<string, IntelDriverRelease>();
    let catalogError = false;
    let catalogPartial = false;
    let catalogLoading = true;
    const root = el('div', { class: 'driver-library-page' });
    container.replaceChildren(root);

    const selectedDeviceKind = (): IntelDriverKind | null => {
      const state = ctx.store.get();
      const device = state.devices.find((item) => item.id === state.deviceId);
      return device ? intelDriverKind(device.gpuVendor, device.name) : null;
    };

    const selectedInstalledVersion = (): string => {
      const state = ctx.store.get();
      const device = state.devices.find((item) => item.id === state.deviceId);
      return decodeDriverVersion(device?.osController?.driverVersion ?? device?.driverVersion) ?? '—';
    };

    const updateDownloaded = (release: IntelDriverRelease) => {
      downloaded = false;
      void libraryApi.intelDriverDownloadStatus(kind!, release.version).then((status) => {
        if (selected !== release) return;
        downloaded = status.downloaded;
        renderDetails();
      }).catch(() => {
        if (selected !== release) return;
        downloaded = false;
        renderDetails();
      });
    };

    const loadRelease = (version: string) => {
      selectedVersion = version;
      selected = releaseCache.get(version) ?? null;
      downloaded = false;
      detailsLoading = !selected;
      detailsError = false;
      const request = ++requestId;
      render();
      if (selected) {
        updateDownloaded(selected);
        return;
      }
      void libraryApi.intelDriverRelease(kind!, version).then((release) => {
        if (!root.isConnected || request !== requestId || selectedVersion !== version) return;
        if (!release || release.version !== version) throw new Error('Intel returned unexpected release details');
        releaseCache.set(version, release);
        selected = release;
        detailsLoading = false;
        render();
        updateDownloaded(release);
      }).catch(() => {
        if (!root.isConnected || request !== requestId || selectedVersion !== version) return;
        detailsLoading = false;
        detailsError = true;
        render();
      });
    };

    const renderDetails = () => {
      const details = root.querySelector<HTMLElement>('.driver-library-details');
      if (!details) return;
      clear(details);
      if (!selected) {
        details.append(el('p', { class: 'driver-library-empty', text: selectedVersion
          ? (detailsLoading ? 'Loading this release from Intel…' : detailsError ? 'Could not load this release. Select it again to retry.' : 'Select a driver version to review its release notes and download options.')
          : 'Select a driver version to review its release notes and download options.' }));
        return;
      }
      const release = selected;
      details.append(
        el('div', { class: 'driver-library-release-heading' }, [
          el('div', {}, [el('h2', { text: `Intel Graphics Driver ${release.version}` }), el('p', { class: 'page-subtitle', text: `${releaseDate(release.releaseDate)} · ${sizeLabel(release.sizeBytes)}` })]),
          el('button', { class: 'btn btn-primary', type: 'button', text: downloaded ? 'Install downloaded driver' : 'Download and Install', onClick: () => showIntelDriverUpdateDialog(kind!, selectedInstalledVersion(), release, downloaded, () => {
            if (selected === release) { downloaded = true; renderDetails(); }
          }) }),
        ]),
        el('section', { class: 'driver-library-changelog' }, [
          el('h3', { text: 'Intel highlights and changelog' }),
          release.changelog.length
            ? el('ul', {}, release.changelog.map((entry) => el('li', { text: entry })))
            : el('p', { class: 'driver-library-empty', text: 'Intel has not published release highlights for this version.' }),
        ]),
      );
    };

    const render = () => {
      kind = selectedDeviceKind();
      clear(root);
      root.setAttribute('data-kind', String(kind));
      root.setAttribute('data-device-id', String(ctx.store.get().deviceId));
      root.append(el('header', { class: 'page-title-row' }, [
        el('div', {}, [el('h1', { class: 'page-title', text: 'Driver Library' }), el('p', { class: 'page-subtitle', text: 'Intel releases for this GPU. Select a version to review its details and install.' })]),
      ]));
      const layout = el('div', { class: 'driver-library-layout' });
      const list = el('section', { class: 'driver-library-list card', 'aria-label': 'Available Intel drivers' });
      const details = el('section', { class: 'driver-library-details card', 'aria-live': 'polite' });
      layout.append(list, details);
      root.append(layout);
      if (!kind) {
        list.append(el('h2', { class: 'card-title', text: 'Available versions' }), el('p', { class: 'driver-library-empty', text: 'Driver Library is available for Intel Arc and Intel Arc Pro GPUs. Select a supported Intel GPU to browse its drivers.' }));
        details.append(el('p', { class: 'driver-library-empty', text: 'No supported Intel GPU is selected.' }));
        return;
      }
      list.append(el('h2', { class: 'card-title', text: kind === 'pro' ? 'Intel Arc Pro drivers' : 'Intel Arc drivers' }));
      if (catalogError) {
        list.append(el('p', { class: 'driver-library-empty text-error', text: 'Intel’s driver catalog is unavailable. Check your connection and reopen Driver Library to try again.' }));
        details.append(el('p', { class: 'driver-library-empty', text: 'Release details are unavailable.' }));
        return;
      }
      if (catalogLoading) {
        list.append(el('p', { class: 'driver-library-empty', text: 'Loading Intel driver releases…' }));
        details.append(el('p', { class: 'driver-library-empty', text: 'Release details will appear when the catalog loads.' }));
        return;
      }
      if (catalogPartial) {
        list.append(el('p', { class: 'driver-library-empty text-error', text: 'Some Intel version entries could not be read. This list may be incomplete.' }));
      }
      if (!versions.length) {
        list.append(el('p', { class: 'driver-library-empty', text: 'No driver releases are currently available for this GPU family.' }));
        details.append(el('p', { class: 'driver-library-empty', text: 'No release is available to select.' }));
        return;
      }
      for (const version of versions) {
        const isSelected = selectedVersion === version;
        list.append(el('button', {
          class: `driver-library-release${isSelected ? ' is-selected' : ''}`,
          type: 'button', 'aria-pressed': String(isSelected),
          onClick: () => loadRelease(version),
        }, [el('strong', { text: version }), ...(isSelected
          ? [el('span', { text: selected ? `${releaseDate(selected.releaseDate)} · ${sizeLabel(selected.sizeBytes)}` : (detailsLoading ? 'Loading release details…' : 'Release details unavailable') })]
          : [])]));
      }
      renderDetails();
    };

    render();
    if (kind) void libraryApi.intelDriverLibrary(kind).then((catalog) => {
      if (!root.isConnected) return;
      catalogLoading = false;
      catalogPartial = catalog.partial === true;
      versions = (catalog.versions ?? []).filter((version) => typeof version === 'string' && /^\d{1,5}(?:\.\d{1,5}){3}$/.test(version));
      selectedVersion = versions[0] ?? null;
      render();
      if (selectedVersion) loadRelease(selectedVersion);
    }).catch(() => {
      if (!root.isConnected) return;
      catalogLoading = false;
      catalogError = true;
      render();
    });
  },
  onUpdate(container, ctx) {
    const currentKind = (() => {
      const state = ctx.store.get();
      const device = state.devices.find((item) => item.id === state.deviceId);
      return device ? intelDriverKind(device.gpuVendor, device.name) : null;
    })();
    const page = container.querySelector('.driver-library-page');
    const deviceId = String(ctx.store.get().deviceId);
    if (page && (page.getAttribute('data-kind') !== String(currentKind) || page.getAttribute('data-device-id') !== deviceId)) {
      page.setAttribute('data-kind', String(currentKind));
      page.setAttribute('data-device-id', deviceId);
      driverLibraryPage.render(container, ctx);
    }
  },
};
