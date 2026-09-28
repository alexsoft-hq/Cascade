// index.mjs — the rule kinds this engine has: HOW a rule is read, where rule packs only say WHAT.
//
// A kind is code, reviewed like code. Adding one is a decision (a new way of
// reading a project); adding a rule of an existing kind is data. When a
// framework's variation does not fit any kind here, the answer is a new kind
// with its own tests, never an expression written inside a rule.
//
// Every kind answers the same things: its `name`, the `lane` whose analysis runs
// it (java, ts, sql), the `stage` of an analysis it runs in, the strongest grade it may give (`gradeCap`, null for a
// classification that draws no edge), `validateParams` (handed the whole rule
// too, for a param whose rules depend on the rule's grade), `validateExample`,
// `compile`, and either `runExample` (one example at a time) or `runExamples`
// (all of them together, for examples that go through a worker once).

import { javaCodeSetting } from './java_code_setting.mjs';
import { javaContractLink } from './java_contract_link.mjs';
import { javaRouteFunction } from './java_route_function.mjs';
import { javaTypeRole } from './java_type_role.mjs';
import { prismaOperation } from './prisma_operation.mjs';
import { sqlDialectPath } from './sql_dialect_path.mjs';
import { tsProviderBinding } from './ts_provider_binding.mjs';
import { tsRouteDecorator } from './ts_route_decorator.mjs';
import { tsTypeRole } from './ts_type_role.mjs';
import { typeormEntity } from './typeorm_entity.mjs';
import { typeormOperation } from './typeorm_operation.mjs';
import { typeormQueryBuilder } from './typeorm_query_builder.mjs';
import { typeormReceiver } from './typeorm_receiver.mjs';

export const KINDS = Object.freeze({
  [javaCodeSetting.name]: javaCodeSetting,
  [javaContractLink.name]: javaContractLink,
  [javaRouteFunction.name]: javaRouteFunction,
  [javaTypeRole.name]: javaTypeRole,
  [prismaOperation.name]: prismaOperation,
  [sqlDialectPath.name]: sqlDialectPath,
  [tsProviderBinding.name]: tsProviderBinding,
  [tsRouteDecorator.name]: tsRouteDecorator,
  [tsTypeRole.name]: tsTypeRole,
  [typeormEntity.name]: typeormEntity,
  [typeormOperation.name]: typeormOperation,
  [typeormQueryBuilder.name]: typeormQueryBuilder,
  [typeormReceiver.name]: typeormReceiver,
});
