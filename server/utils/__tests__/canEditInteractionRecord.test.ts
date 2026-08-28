import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { prisma } from '~/server/utils/prisma'
import { canEditInteractionRecord } from '~/server/utils/projectPermissions'

// Integration test against the local dev DB, same approach as requireMcpAuth.test.ts.
// Covers the two-tier gate canEditInteractionRecord must replicate from
// resolveInteractionAccess's 'edit' mode: a baseline (canViewAll || isAdmin) check, THEN
// (isAdmin || canEditAll || isCreator || isAssignedToNegotiation). Getting this wrong in
// either direction is a permission bug, not a cosmetic one.
describe('canEditInteractionRecord', () => {
  let groupId: string
  let projectId: string
  let globalRecordId: string
  let creatorId: string
  let viewOnlyUserId: string
  let editAllUserId: string
  let noRoleUserId: string
  let adminUserId: string

  beforeAll(async () => {
    const group = await prisma.group.create({ data: { name: 'Vitest canEditInteractionRecord', slug: 'vitest-permtest' } })
    groupId = group.id
    const project = await prisma.project.create({ data: { name: 'Vitest project', slug: 'vitest-permtest-project', groupId } })
    projectId = project.id

    const creator = await prisma.user.create({ data: { email: 'vitest-perm-creator@scg.cz', googleId: 'vitest-perm-creator', name: 'Creator' } })
    creatorId = creator.id
    const viewOnlyUser = await prisma.user.create({ data: { email: 'vitest-perm-viewonly@scg.cz', googleId: 'vitest-perm-viewonly', name: 'View only' } })
    viewOnlyUserId = viewOnlyUser.id
    const editAllUser = await prisma.user.create({ data: { email: 'vitest-perm-editall@scg.cz', googleId: 'vitest-perm-editall', name: 'Edit all' } })
    editAllUserId = editAllUser.id
    const noRoleUser = await prisma.user.create({ data: { email: 'vitest-perm-norole@scg.cz', googleId: 'vitest-perm-norole', name: 'No role' } })
    noRoleUserId = noRoleUser.id
    const adminUser = await prisma.user.create({ data: { email: 'vitest-perm-admin@scg.cz', googleId: 'vitest-perm-admin', name: 'Admin', isAdmin: true } })
    adminUserId = adminUser.id

    const viewRole = await prisma.projectRole.create({ data: { projectId, name: 'Vitest view-only', permissions: ['project.interactions.view_all'] } })
    const editRole = await prisma.projectRole.create({ data: { projectId, name: 'Vitest edit-all', permissions: ['project.interactions.view_all', 'project.interactions.edit_all'] } })
    await prisma.userProjectRole.create({ data: { userId: viewOnlyUserId, projectRoleId: viewRole.id } })
    await prisma.userProjectRole.create({ data: { userId: editAllUserId, projectRoleId: editRole.id } })

    const record = await prisma.globalRecord.create({
      data: { type: 'PARTNER', canonicalName: 'Vitest Partner', normalizedName: 'vitest partner', payload: {}, createdBy: creatorId },
    })
    globalRecordId = record.id
    await prisma.negotiation.create({ data: { projectId, globalRecordId } })
  })

  afterAll(async () => {
    await prisma.group.delete({ where: { id: groupId } }) // cascades project -> negotiation
    await prisma.globalRecord.delete({ where: { id: globalRecordId } })
    await prisma.user.deleteMany({ where: { id: { in: [creatorId, viewOnlyUserId, editAllUserId, noRoleUserId, adminUserId] } } })
  })

  it('allows an admin regardless of role or authorship', async () => {
    expect(await canEditInteractionRecord(adminUserId, projectId, globalRecordId, creatorId)).toBe(true)
  })

  it('denies a user with no project role at all, even as the creator (baseline gate)', async () => {
    expect(await canEditInteractionRecord(noRoleUserId, projectId, globalRecordId, noRoleUserId)).toBe(false)
  })

  it('denies a view_all-only user editing someone else\'s note', async () => {
    expect(await canEditInteractionRecord(viewOnlyUserId, projectId, globalRecordId, creatorId)).toBe(false)
  })

  it('allows a view_all-only user editing their OWN note', async () => {
    expect(await canEditInteractionRecord(viewOnlyUserId, projectId, globalRecordId, viewOnlyUserId)).toBe(true)
  })

  it('allows an edit_all user editing someone else\'s note', async () => {
    expect(await canEditInteractionRecord(editAllUserId, projectId, globalRecordId, creatorId)).toBe(true)
  })
})
