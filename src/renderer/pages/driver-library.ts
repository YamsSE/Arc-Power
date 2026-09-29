import { el, clear, resetScrollPositions } from '../dom.ts';
import type { Page, PageContext } from '../router.ts';
import { api } from '../ipc.ts';
import { intelDriverKind, type IntelDriverKind, type IntelDriverRelease } from '../pure/intel-driver-updates.ts';
import { decodeDriverVersion } from '../pure/driver.ts';
import { showIntelDriverUpdateDialog } from '../components/intel-driver-update-dialog.ts';
import { showIntelDriverDownloadDeleteConfirm } from '../components/intel-driver-download-delete-dialog.ts';
import { renderIntelDriverChangelog } from '../components/intel-driver-changelog.ts';

type DriverLibraryApi = {
  intelDriverLibrary(kind: IntelDriverKind): Promise<{ versions: string[]; partial: boolean }>;
  intelDriverRelease(kind: IntelDriverKind, version: string): Promise<IntelDriverRelease>;
  intelDriverDownloadStatus(kind: IntelDriverKind, version: string): Promise<{ downloaded: boolean; sizeBytes: number | null }>;
  intelDriverDownloadDelete(kind: IntelDriverKind, version: string): Promise<{ deleted: true }>;
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

function driverLibraryDeviceId(devices: Array<{ id: number }>, activeId: number | null, hash: string): number | null {
  const requested = new URLSearchParams(hash.split('?')[1] ?? '').get('deviceId');
  if (requested !== null && /^\d+$/.test(requested)) {
    const id = Number(requested);
    if (Number.isSafeInteger(id) && devices.some((device) => device.id === id)) return id;
  }
  return activeId;
}

export const driverLibraryPage: Page = {
  id: 'driver-library',
  render(container, ctx) {
    let kind: IntelDriverKind | null = null;
    let versions: string[] = [];
    let selected: IntelDriverRelease | null = null;
    let selectedVersion: string | null = null;
    let downloaded = false;
    let downloadStatusLoaded = false;
    let deletingDownloadVersion: string | null = null;
    let deleteErrorVersion: string | null = null;
    let requestId = 0;
    let detailsLoading = false;
    let detailsError = false;
    const releaseCache = new Map<string, IntelDriverRelease>();
    let catalogError = false;
    let catalogPartial = false;
    let catalogLoading = true;
    let searchQuery = '';
    const root = el('div', { class: 'driver-library-page' });
    container.replaceChildren(root);

    const selectedDevice = () => {
      const state = ctx.store.get();
      const deviceId = driverLibraryDeviceId(state.devices, state.deviceId, window.location.hash);
      return state.devices.find((item) => item.id === deviceId) ?? null;
    };

    const selectedDeviceKind = (): IntelDriverKind | null => {
      const device = selectedDevice();
      return device ? intelDriverKind(device.gpuVendor, device.name) : null;
    };

    const selectedInstalledVersion = (): string => {
      const device = selectedDevice();
      return decodeDriverVersion(device?.osController?.driverVersion ?? device?.driverVersion) ?? '—';
    };

    const updateDownloaded = (release: IntelDriverRelease) => {
      downloaded = false;
      downloadStatusLoaded = false;
      deleteErrorVersion = null;
      renderDetails();
      void libraryApi.intelDriverDownloadStatus(kind!, release.version).then((status) => {
        if (selected !== release) return;
        downloaded = status.downloaded;
        downloadStatusLoaded = true;
        renderDetails();
      }).catch(() => {
        if (selected !== release) return;
        downloaded = false;
        downloadStatusLoaded = true;
        renderDetails();
      });
    };

    const loadRelease = (version: string) => {
      selectedVersion = version;
      selected = releaseCache.get(version) ?? null;
      downloaded = false;
      downloadStatusLoaded = false;
      deleteErrorVersion = null;
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
      const releaseKind = kind;
      const deleting = deletingDownloadVersion === release.version;
      const deleteBusy = deletingDownloadVersion !== null;
      const actions = el('div', { class: 'driver-library-release-actions' });
      if (!downloadStatusLoaded) {
        actions.append(el('button', {
          class: 'btn btn-primary', type: 'button', disabled: true, text: 'Checking download…',
        }));
      } else {
        actions.append(el('button', {
          class: 'btn btn-primary', type: 'button',
          disabled: deleteBusy,
          text: downloaded ? 'Install downloaded driver' : 'Download and Install',
          onClick: () => showIntelDriverUpdateDialog(releaseKind!, selectedInstalledVersion(), release, downloaded, () => {
            if (selected === release) {
              downloaded = true;
              downloadStatusLoaded = true;
              renderDetails();
            }
          }),
        }));
        if (downloaded) {
          actions.append(el('button', {
            class: 'btn btn-ghost btn-sm btn-danger-text driver-library-delete-download',
            type: 'button', disabled: deleteBusy,
            title: 'Delete the downloaded installer file. This does not uninstall the driver.',
            'aria-label': `Delete the downloaded installer file for Intel driver ${release.version}`,
            text: deleting ? 'Deleting…' : 'Delete Download',
            onClick: () => {
              if (!releaseKind || deletingDownloadVersion) return;
              void (async () => {
                const confirmed = await showIntelDriverDownloadDeleteConfirm(release.version);
                if (!confirmed || !root.isConnected || selected !== release || selectedVersion !== release.version || kind !== releaseKind || deletingDownloadVersion) return;
                deletingDownloadVersion = release.version;
                deleteErrorVersion = null;
                renderDetails();
                try {
                  const result = await libraryApi.intelDriverDownloadDelete(releaseKind, release.version);
                  if (result?.deleted !== true) throw new Error('The downloaded driver was not deleted');
                  if (root.isConnected && selected === release && selectedVersion === release.version && kind === releaseKind) {
                    downloaded = false;
                    downloadStatusLoaded = true;
                  }
                } catch {
                  if (root.isConnected && selected === release && selectedVersion === release.version && kind === releaseKind) deleteErrorVersion = release.version;
                } finally {
                  if (deletingDownloadVersion === release.version) deletingDownloadVersion = null;
                  if (root.isConnected) renderDetails();
                }
              })();
            },
          }));
        }
      }
      details.append(
        el('div', { class: 'driver-library-release-heading' }, [
          el('div', {}, [el('h2', { text: `Intel Graphics Driver ${release.version}` }), el('p', { class: 'page-subtitle', text: `${releaseDate(release.releaseDate)} · ${sizeLabel(release.sizeBytes)}` })]),
          actions,
        ]),
        ...(deleteErrorVersion === release.version
          ? [el('p', { class: 'driver-library-delete-error text-error', role: 'status', text: 'Could not delete the downloaded file. Please try again.' })]
          : []),
        el('section', { class: 'driver-library-changelog' }, [
          el('h3', { text: 'Intel highlights and changelog' }),
          (release.changelogSections?.length || release.changelog.length)
            ? renderIntelDriverChangelog(release)
            : el('p', { class: 'driver-library-empty', text: 'Intel has not published release highlights for this version.' }),
        ]),
      );
    };

    const render = (restoreSearchFocus = false, caret = 0) => {
      kind = selectedDeviceKind();
      clear(root);
      root.setAttribute('data-kind', String(kind));
      root.setAttribute('data-device-id', String(selectedDevice()?.id ?? ''));
      root.append(el('header', { class: 'page-title-row' }, [
        el('div', {}, [el('h1', { class: 'page-title', text: 'Driver Library' }), el('p', { class: 'page-subtitle', text: 'Intel releases for this GPU. Select a version to review its details and install.' }), el('p', { class: 'driver-library-catalog-note', text: 'The catalog includes versions Intel currently exposes on its current and historical driver pages.' })]),
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
      const search = el('input', {
        class: 'driver-library-search', type: 'search', placeholder: 'Search driver versions',
        'aria-label': 'Search driver versions', value: searchQuery,
        onInput: (event: Event) => {
          const input = event.currentTarget as HTMLInputElement;
          searchQuery = input.value;
          render(true, input.selectionStart ?? searchQuery.length);
          // A new query should show the first matching release, even though
          // ordinary list rerenders preserve the reader's current position.
          queueMicrotask(() => {
            const releaseList = root.querySelector<HTMLElement>('.driver-library-release-list');
            if (releaseList) resetScrollPositions(releaseList);
          });
        },
      }) as HTMLInputElement;
      list.append(search);
      const versionScroller = el('div', {
        class: 'driver-library-release-list', role: 'region', tabindex: 0,
        'aria-label': 'Available driver versions',
      });
      list.append(versionScroller);
      if (restoreSearchFocus) {
        search.focus();
        search.setSelectionRange(caret, caret);
      }
      if (catalogError) {
        versionScroller.append(el('p', { class: 'driver-library-empty text-error', text: 'Intel’s driver catalog is unavailable. Check your connection and reopen Driver Library to try again.' }));
        details.append(el('p', { class: 'driver-library-empty', text: 'Release details are unavailable.' }));
        return;
      }
      if (catalogLoading) {
        versionScroller.append(el('p', { class: 'driver-library-empty', text: 'Loading Intel driver releases…' }));
        details.append(el('p', { class: 'driver-library-empty', text: 'Release details will appear when the catalog loads.' }));
        return;
      }
      if (catalogPartial) {
        versionScroller.append(el('p', { class: 'driver-library-empty text-error', text: 'Some Intel version entries could not be read. This list may be incomplete.' }));
      }
      if (!versions.length) {
        versionScroller.append(el('p', { class: 'driver-library-empty', text: 'No driver releases are currently available for this GPU family.' }));
        details.append(el('p', { class: 'driver-library-empty', text: 'No release is available to select.' }));
        return;
      }
      const filteredVersions = versions.filter((version) => version.toLowerCase().includes(searchQuery.trim().toLowerCase()));
      if (!filteredVersions.length && searchQuery.trim()) {
        versionScroller.append(el('p', { class: 'driver-library-empty', text: 'No driver versions match your search.' }));
      }
      for (const version of filteredVersions) {
        const isSelected = selectedVersion === version;
        versionScroller.append(el('button', {
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
    const state = ctx.store.get();
    const selectedId = driverLibraryDeviceId(state.devices, state.deviceId, window.location.hash);
    const currentKind = (() => {
      const device = state.devices.find((item) => item.id === selectedId);
      return device ? intelDriverKind(device.gpuVendor, device.name) : null;
    })();
    const page = container.querySelector('.driver-library-page');
    const deviceId = String(state.devices.find((item) => item.id === selectedId)?.id ?? '');
    if (page && (page.getAttribute('data-kind') !== String(currentKind) || page.getAttribute('data-device-id') !== deviceId)) {
      page.setAttribute('data-kind', String(currentKind));
      page.setAttribute('data-device-id', deviceId);
      driverLibraryPage.render(container, ctx);
    }
  },
};
