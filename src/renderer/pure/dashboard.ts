// M30: dashboard static data must follow the selected inventory record.

export interface DashboardController {
  name?: string | null;
  vramBytes?: number | null;
  pnpDeviceId?: string | null;
  driverVersion?: string | null;
  rebarActive?: boolean | null;
}

export function selectedDashboardController(
  selectedController: DashboardController | null | undefined,
  noDeviceController: DashboardController | null | undefined,
  hasSelectedDevice: boolean,
): DashboardController | null {
  return (hasSelectedDevice ? selectedController : noDeviceController) ?? null;
}
