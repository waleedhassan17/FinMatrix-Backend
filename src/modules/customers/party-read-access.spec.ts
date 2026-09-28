import { ExecutionContext, ForbiddenException, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from '../../common/guards/roles.guard';
import { CustomersController } from './customers.controller';
import { VendorsController } from '../vendors/vendors.controller';

/**
 * Who may read customers and vendors.
 *
 * The GET routes on both controllers used to carry no @Roles at all, and the
 * RolesGuard lets an undecorated route through for ANY company member — so a
 * delivery rider could list every customer and vendor, with balances and
 * statements. Owners and staff read them; riders do not.
 *
 * Every route is found from the controller's own metadata rather than listed
 * here, so a GET added later without a role is covered the day it is added.
 */
type Ctor = { prototype: Record<string, unknown>; name: string };

const routesOf = (controller: Ctor) =>
  Object.getOwnPropertyNames(controller.prototype)
    .filter((name) => name !== 'constructor')
    .map((name) => ({ name, handler: controller.prototype[name] as (...args: unknown[]) => unknown }))
    .filter(({ handler }) => Reflect.getMetadata(PATH_METADATA, handler) !== undefined)
    .map((r) => ({ ...r, method: Reflect.getMetadata(METHOD_METADATA, r.handler) as RequestMethod }));

const allowed = (controller: Ctor, handler: (...args: unknown[]) => unknown, role: string): boolean => {
  const guard = new RolesGuard(new Reflector());
  const context = {
    getHandler: () => handler,
    getClass: () => controller,
    switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
  } as unknown as ExecutionContext;
  try {
    return guard.canActivate(context);
  } catch (e) {
    if (e instanceof ForbiddenException) return false;
    throw e;
  }
};

describe.each([
  ['customers', CustomersController as unknown as Ctor],
  ['vendors', VendorsController as unknown as Ctor],
])('%s — read access', (_label, controller) => {
  const routes = routesOf(controller);
  const reads = routes.filter((r) => r.method === RequestMethod.GET);

  it('has the read routes this test is about', () => {
    // list, one record, its documents, its payments, its statement.
    expect(reads.length).toBeGreaterThanOrEqual(5);
  });

  it.each(reads.map((r) => [r.name, r] as const))('refuses a delivery rider: %s', (_name, route) => {
    expect(allowed(controller, route.handler, 'delivery')).toBe(false);
  });

  it.each(reads.map((r) => [r.name, r] as const))('lets owners and staff read: %s', (_name, route) => {
    expect(allowed(controller, route.handler, 'admin')).toBe(true);
    expect(allowed(controller, route.handler, 'staff')).toBe(true);
  });

  it('keeps the narrower rules on writes: staff create and edit, only the owner deletes or deactivates', () => {
    for (const route of routes.filter((r) => r.method !== RequestMethod.GET)) {
      expect(allowed(controller, route.handler, 'delivery')).toBe(false);
      expect(allowed(controller, route.handler, 'admin')).toBe(true);
      const staffMay = route.method === RequestMethod.POST || (route.method === RequestMethod.PATCH && !/toggle/i.test(route.name));
      expect({ route: route.name, staff: allowed(controller, route.handler, 'staff') }).toEqual({
        route: route.name,
        staff: staffMay,
      });
    }
  });
});
