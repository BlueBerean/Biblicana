const joi = require('joi');

const userModel = joi.object({
    id: joi.string().required(),
    translation: joi.string().default('BSB'),
});

module.exports = userModel;