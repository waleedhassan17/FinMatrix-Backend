import {
  isRoleAllowedOnPortal,
  PORTAL_ROLES,
  SIGNIN_PORTALS,
  wrongPortalMessage,
} from './signin-portal';

describe('signin portals', () => {
  it('admits only owners (and the platform console) on the owner door', () => {
    expect(isRoleAllowedOnPortal('admin', 'admin')).toBe(true);
    expect(isRoleAllowedOnPortal('admin', 'super_admin')).toBe(true);
    expect(isRoleAllowedOnPortal('admin', 'staff')).toBe(false);
    expect(isRoleAllowedOnPortal('admin', 'delivery')).toBe(false);
  });

  it('admits only team members on the staff door', () => {
    expect(isRoleAllowedOnPortal('staff', 'staff')).toBe(true);
    expect(isRoleAllowedOnPortal('staff', 'admin')).toBe(false);
    expect(isRoleAllowedOnPortal('staff', 'super_admin')).toBe(false);
    expect(isRoleAllowedOnPortal('staff', 'delivery')).toBe(false);
  });

  it('admits staff and riders on the app user portal, never an owner', () => {
    expect(isRoleAllowedOnPortal('team', 'staff')).toBe(true);
    expect(isRoleAllowedOnPortal('team', 'delivery')).toBe(true);
    expect(isRoleAllowedOnPortal('team', 'admin')).toBe(false);
    expect(isRoleAllowedOnPortal('delivery', 'staff')).toBe(false);
  });

  it('defines every portal', () => {
    expect(Object.keys(PORTAL_ROLES).sort()).toEqual(
      [...SIGNIN_PORTALS].sort(),
    );
  });

  it('points each account at its own door', () => {
    expect(wrongPortalMessage('admin')).toMatch(/business owner account/);
    expect(wrongPortalMessage('staff')).toMatch(/team member account/);
    expect(wrongPortalMessage('delivery')).toMatch(/Android app/);
  });
});
