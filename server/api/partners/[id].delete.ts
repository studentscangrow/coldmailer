import { prisma } from '~/server/utils/prisma'
import { requireAuth } from '~/server/utils/requireAuth'
import { canManagePartnersGlobally } from '~/server/utils/projectPermissions'

export default defineEventHandler(async (event) => {
  const session = await requireAuth(event)
  const id = getRouterParam(event, 'id')!

  // Deleting a GlobalRecord is permanent and cascades across every project it's in — restrict
  // to admin / Vedení obchodu, unlike most partner actions which any authenticated user can do.
  if (!(await canManagePartnersGlobally(session.id))) {
    throw createError({ statusCode: 403, message: 'Smazání partnera je dostupné jen pro vedení obchodu a administrátory.' })
  }

  const existing = await prisma.globalRecord.findUnique({ where: { id }, select: { id: true, type: true } })
  if (!existing) throw createError({ statusCode: 404, message: 'Partner nenalezen.' })
  if (existing.type !== 'PARTNER') throw createError({ statusCode: 400, message: 'Záznam není typu PARTNER.' })

  await prisma.$transaction([
    prisma.recordEvent.deleteMany({ where: { globalRecordId: id } }),
    prisma.partnerContact.deleteMany({ where: { globalRecordId: id } }),
    prisma.globalRecord.delete({ where: { id } }),
  ])

  return { success: true }
})
