import joi from 'joi';

const userModel = joi.object({
    id: joi.string().required(),
    translation: joi.string().default('BSB'),
});

export default userModel;
