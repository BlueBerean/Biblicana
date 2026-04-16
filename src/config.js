import 'dotenv/config';

const postgresConfig = {
    host: process.env.PGHOST,
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    database: process.env.PGDATABASE,
    ssl: {
        rejectUnauthorized: true
    },
    port: 5432
};

export { postgresConfig };
export default { postgresConfig };
