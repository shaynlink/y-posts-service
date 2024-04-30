import { ErrorResponse, HTTPHandle, Route } from 'codebase'
import type { Model, ObjectId, Query } from 'mongoose'
import { IPost, IUser, PostSchema } from './shemas'
import pkg from '../package.json'
import axios from 'axios'
import { AuthorizationVerifyResponse } from 'y-types/service'
import { Types, isValidObjectId, Document } from 'mongoose'

export function setUpHandle(handle: HTTPHandle) {
  handle.initiateHealthCheckRoute(pkg.version);

  const Post: Model<IPost> = handle.app.locals.schema.Post;
  const User: Model<IUser> = handle.app.locals.schema.User;

  handle.createRoute('/',(route: Route) => {
    route.setGlobalMiddleware('Verify jwt token', async (req, res, next) => {
      try {
        if (!req.headers.authorization) {
          return handle.createResponse(req, res, null, new ErrorResponse('Missing authorization', 401));
        }
  
        const [type, token] = req.headers.authorization.split(' ');

        if (type !== 'Bearer') {
          return handle.createResponse(req, res, null, new ErrorResponse('Unauthorized token type', 401));
        }
  
        if (!token) {
          return handle.createResponse(req, res, null, new ErrorResponse('Missing token', 401));
        }
  
        const response = await axios.post<AuthorizationVerifyResponse>('https://authorization-service-2fqcvdzp6q-ew.a.run.app', {
          type: 'verify',
          token
        })
          .catch((e) => e.response);

        if (response.status !== 200) {
          throw new Error('Unable to create user');
        }

        if (response.data.error) {
          return new Error(response.data.error.message);
        }

        if (!response.data.result) {
          return handle.createResponse(req, res, null, new ErrorResponse('Authorization service unable verify token', 500));
        }

        const {valide, decoded} = response.data.result;

        if (!valide) {
          return handle.createResponse(req, res, null, new ErrorResponse('Unauthorized token', 401));
        }

        res.locals.authorization = decoded;

        next();
      } catch (error) {
        console.error(error);

        return handle.createResponse(req, res, null, new ErrorResponse('Unable to verify token', 500));
      }
    })

    route.setGlobalMiddleware('Verify audience authorization', (req, res, next) => {
      const { aud } = res.locals.authorization;

      const [platform, location, target] = aud.split(':');

      if (platform != 'y') {
        return handle.createResponse(req, res, null, new ErrorResponse('Unauthorized audience platform', 401));
      }

      if (location !== 'services' && location !== '*') {
        return handle.createResponse(req, res, null, new ErrorResponse('Unauthorized audience location', 401));
      }

      if (target !== 'users' && target !== '*') {
        return handle.createResponse(req, res, null, new ErrorResponse('Unauthorized audience target', 401));
      }

      next();
    })

    route.setGlobalMiddleware('Verify subject authorization', async (req, res, next) => {
      const { sub } = res.locals.authorization;

      const [platform, location, id] = sub.split(':');

      if (platform != 'y') {
        return handle.createResponse(req, res, null, new ErrorResponse('Unauthorized subject platform', 401));
      }

      if (location !== 'users' && location !== '*') {
        return handle.createResponse(req, res, null, new ErrorResponse('Unauthorized subject location', 401));
      }

      if (!id) {
        return handle.createResponse(req, res, null, new ErrorResponse('Unauthorized subject id', 401));
      }

      if (!isValidObjectId(id)) {
        return handle.createResponse(req, res, null, new ErrorResponse('Invalid subject id', 401));
      }

      res.locals.userId = Types.ObjectId.createFromHexString(id);

      next();
    })

    route.mapper.post('', async (req, res) => {
      try {
        if (!req.body.content) {
          return handle.createResponse(req, res, null, new ErrorResponse('Missing body content', 401));
        }

        const post = new Post({
          user: res.locals.userId,
          content: req.body.content,
          images: req.body.images || []
        });

        await post.save();

        return handle.createResponse(req, res, post, null);
      } catch (error) {
        console.error(error);
        return handle.createResponse(req, res, null, new ErrorResponse('Unable to create post', 500));
      }
    })

    route.mapper.get('/:id', async (req, res) => {
      try {
        if (!req.params.id) {
          return handle.createResponse(req, res, null, new ErrorResponse('Unauthorized subject id', 401));
        }
  
        if (!isValidObjectId(req.params.id)) {
          return handle.createResponse(req, res, null, new ErrorResponse('Invalid subject id', 401));
        }

        const id = Types.ObjectId.createFromHexString(req.params.id);

        const postDoc = await Post
          .findById(id)
          .select({ _id: 1, user: 1 ,content: 1, images:1, timestamp: 1, likes: 1, reposts: 1})
          .populate('user', { _id: 1, username: 1 })
          .exec() as unknown as typeof PostSchema & { _doc: IPost & { _id: ObjectId } };

        const post = {
          ...postDoc._doc
        }

        return handle.createResponse(req, res, post, null);
      } catch (error) {
        console.error(error);
        return handle.createResponse(req, res, null, new ErrorResponse('Unable to get post', 500));
      }
    })

    route.mapper.delete('/:id', async (req, res) => {
      try {
        if (!req.params.id) {
          return handle.createResponse(req, res, null, new ErrorResponse('Missing params id', 401));
        }
  
        if (!isValidObjectId(req.params.id)) {
          return handle.createResponse(req, res, null, new ErrorResponse('Invalid params id', 401));
        }

        const id = Types.ObjectId.createFromHexString(req.params.id);

        const postDoc = await Post
          .findById(id)
          .exec() as unknown as Query<IPost, Document<IPost>> & { _doc: IPost & { _id: ObjectId } };

        if (!postDoc) {
          return handle.createResponse(req, res, null, new ErrorResponse('Post not found', 404));
        }

        if (!(postDoc as any).user.equals(res.locals.userId)) {
          return handle.createResponse(req, res, null, new ErrorResponse('Unauthorized user', 401));
        }

        await postDoc.deleteOne()

        return res.status(204).end();
      } catch (error) {
        console.error(error);
        return handle.createResponse(req, res, null, new ErrorResponse('Unable to delete post', 500));
      }
    })

    route.mapper.post('/:id/repost', async (req, res) => {
      try {
        if (!req.params.id) {
          return handle.createResponse(req, res, null, new ErrorResponse('Missing params id', 401));
        }
  
        if (!isValidObjectId(req.params.id)) {
          return handle.createResponse(req, res, null, new ErrorResponse('Invalid params id', 401));
        }

        const id = Types.ObjectId.createFromHexString(req.params.id);

        const postDoc = await Post
          .findById(id)
          .select({ _id: 1, user: 1 ,content: 1, images:1, timestamp: 1, likes: 1, reposts: 1})
          .populate('user', { _id: 1, username: 1 })
          .exec() as unknown as Query<IPost, Document<IPost>> & { _doc: IPost & { _id: ObjectId } };

        if (!postDoc) {
          return handle.createResponse(req, res, null, new ErrorResponse('Post not found', 404));
        }

        const repost = new Post({
          user: res.locals.userId,
          content: (await postDoc).content,
          images: (await postDoc).images,
          reposts: [postDoc._doc._id]
        });

        await repost.save();

        return handle.createResponse(req, res, null, null);
      } catch (error) {
        console.error(error);
        return handle.createResponse(req, res, null, new ErrorResponse('Unable to repost post', 500));
      }
    })

    route.mapper.put('/:id/like', async (req, res) => {
      try {
        if (!req.params.id) {
          return handle.createResponse(req, res, null, new ErrorResponse('Missing params id', 401));
        }
  
        if (!isValidObjectId(req.params.id)) {
          return handle.createResponse(req, res, null, new ErrorResponse('Invalid params id', 401));
        }

        const id = Types.ObjectId.createFromHexString(req.params.id);

        const postDoc = await Post
          .findById(id)
          .select({ _id: 1, user: 1 ,content: 1, images: 1, timestamp: 1, likes: 1, reposts: 1})
          .populate('user', { _id: 1, username: 1 })
          .exec()

        if (!postDoc) {
          return handle.createResponse(req, res, null, new ErrorResponse('Post not found', 404));
        }

        if (postDoc.likes.includes(res.locals.userId)) {
          return handle.createResponse(req, res, null, new ErrorResponse('Already liked post', 400));
        }

        postDoc.likes.push(res.locals.userId);

        await postDoc.save();

        return handle.createResponse(req, res, null, null);
      } catch (error) {
        console.error(error);
        return handle.createResponse(req, res, null, new ErrorResponse('Unable to like post', 500));
      }
    })

    route.mapper.delete('/:id/like', async (req, res) => {
      try {
        if (!req.params.id) {
          return handle.createResponse(req, res, null, new ErrorResponse('Missing params id', 401));
        }
  
        if (!isValidObjectId(req.params.id)) {
          return handle.createResponse(req, res, null, new ErrorResponse('Invalid params id', 401));
        }

        const id = Types.ObjectId.createFromHexString(req.params.id);

        const postDoc = await Post
          .findById(id)
          .select({ _id: 1, user: 1 ,content: 1, images: 1, timestamp: 1, likes: 1, reposts: 1})
          .populate('user', { _id: 1, username: 1 })
          .exec();

        if (!postDoc) {
          return handle.createResponse(req, res, null, new ErrorResponse('Post not found', 404));
        }

        if (!postDoc.likes.includes(res.locals.userId)) {
          return handle.createResponse(req, res, null, new ErrorResponse('Not liked post', 400));
        }

        postDoc.likes = postDoc.likes.filter((userId) => !userId == (res.locals.userId));

        await postDoc.save();

        return handle.createResponse(req, res, null, null);
      } catch (error) {
        console.error(error);
        return handle.createResponse(req, res, null, new ErrorResponse('Unable to unlike post', 500));
      }
    })
    // un feed est une liste de post. il existe plusieurs type de feed (all post, following feed, user feed, custom list of user feed, etc...)
    //get/feed
    route.mapper.get('/feed', async (req, res) => {
      try {
        const posts = await Post
          .find()
          .select({ _id: 1, user: 1 ,content: 1, images: 1, timestamp: 1, likes: 1, reposts: 1})
          .populate('user', { _id: 1, username: 1 })
          .exec();

        return handle.createResponse(req, res, posts, null);
      } catch (error) {
        console.error(error);
        return handle.createResponse(req, res, null, new ErrorResponse('Unable to get feed', 500));
      }
    })
    
    // on peut creer un custom feed en fontion du parametre qui redirige vers une list de user id
    //post/feed
    route.mapper.post('/feed', async (req, res) => {
      try {
        if (!req.body.userIds) {
          return handle.createResponse(req, res, null, new ErrorResponse('Missing body userIds', 401));
        }

        if (!Array.isArray(req.body.userIds)) {
          return handle.createResponse(req, res, null, new ErrorResponse('Invalid body userIds', 401));
        }

        const posts = await Post
          .find({ user: { $in: req.body.userIds } })
          .select({ _id: 1, user: 1 ,content: 1, images: 1, timestamp: 1, likes: 1, reposts: 1})
          .populate('user', { _id: 1, username: 1 })
          .exec();

        return handle.createResponse(req, res, posts, null);
      } catch (error) {
        console.error(error);
        return handle.createResponse(req, res, null, new ErrorResponse('Unable to get feed', 500));
      }
    })

  })

  handle.initiateNotFoundRoute();
}