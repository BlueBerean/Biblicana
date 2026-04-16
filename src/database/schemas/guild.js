import joi from 'joi';

const guildModel = joi.object({
    id: joi.string().required(),
});

export default guildModel;
