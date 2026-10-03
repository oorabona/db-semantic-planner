export const schema = {
	users: {
		id: { type: 'integer', primaryKey: true },
		name: 'string',
	},
};

export const cases = {
	select: (orm, core) => orm.select('users').where(core.eq('id', 7)),
	throwing: () => {
		throw new Error('intentional build failure');
	},
	insert: (orm) => orm.insert('users').values({ id: 8, name: 'Ada' }),
	dumpThrowing: () => ({
		dump() {
			throw new Error('intentional dump failure');
		},
	}),
};
