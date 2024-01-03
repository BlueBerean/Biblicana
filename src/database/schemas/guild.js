const joi = require('joi');

const guildModel = joi.object({
    id: joi.string().required(),
});

module.exports = guildModel;